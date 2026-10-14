const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const OracleDriver = require('../out/ls/driver').default;

const sql = "SELECT x.REPLICATION_ENABLED_FLG, x.* FROM MDA_00.T0035_ARCH_CONF x WHERE x.table_nm IN ('example')";

function setup(names = ['REPLICATION_ENABLED_FLG', 'REPLICATION_ENABLED_FLG', 'TABLE_NM'], rows = [
  [1, 2, 'first'], [3, 4, 'second'], [5, 6, 'third'],
]) {
  const driver = new OracleDriver({ id: 'duplicates', name: 'test', driver: 'Oracle' }, async () => []);
  const calls = [];
  let closed = 0;
  const conn = {
    execute: async (query, _binds, options) => {
      calls.push({ query, options });
      if (query.includes('DBMS_OUTPUT.GET_LINE')) return { outBinds: { st: 1 } };
      if (query.includes('DBMS_OUTPUT.ENABLE')) return {};
      if (query.startsWith('SELECT * FROM (')) {
        throw Object.assign(new Error('ORA-00918: column ambiguously defined'), { errorNum: 918 });
      }
      assert.equal(query, sql);
      assert.equal(options.outFormat, driver.lib.OUT_FORMAT_ARRAY);
      assert.equal(options.resultSet, true);
      let position = 0;
      return {
        metaData: names.map(name => ({ name })),
        resultSet: {
          getRows: async count => {
            const fetched = rows.slice(position, position + count);
            position += fetched.length;
            return fetched;
          },
          close: async () => { closed++; },
        },
      };
    },
  };
  driver.open = async () => conn;
  driver.resolveResultEditability = async () => ({ editable: true });
  return { driver, conn, calls, closed: () => closed };
}

test('duplicate projection paginates the unchanged original SELECT and retains both values', async () => {
  const state = setup();
  const [result] = await state.driver.query(sql, { requestId: 'test', pageSize: 2 });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.cols, ['REPLICATION_ENABLED_FLG', 'REPLICATION_ENABLED_FLG (1)', 'TABLE_NM']);
  assert.deepEqual(result.results, [
    { REPLICATION_ENABLED_FLG: 1, 'REPLICATION_ENABLED_FLG (1)': 2, TABLE_NM: 'first' },
    { REPLICATION_ENABLED_FLG: 3, 'REPLICATION_ENABLED_FLG (1)': 4, TABLE_NM: 'second' },
  ]);
  assert.equal(result.editable, false);
  assert.equal(result.query, sql);
  assert.equal(result.total, 3);
  assert.equal(state.closed(), 1);
  assert.equal(state.calls.filter(call => call.query === sql).length, 1);
  assert.equal(state.calls.some(call => call.query.includes('COUNT(*)')), false);
});

test('second cursor page skips earlier records without truncating the source query', async () => {
  const state = setup();
  const [result] = await state.driver.query(sql, { requestId: 'test', pageSize: 2, page: 1 });
  assert.deepEqual(result.results, [{ REPLICATION_ENABLED_FLG: 5, 'REPLICATION_ENABLED_FLG (1)': 6, TABLE_NM: 'third' }]);
  assert.equal(result.page, 1);
  assert.equal(result.total, 3);
  assert.equal(state.closed(), 1);
});

test('empty duplicate-column results preserve all headers', async () => {
  const state = setup(undefined, []);
  const [result] = await state.driver.query(sql, { pageSize: 2 });
  assert.deepEqual(result.cols, ['REPLICATION_ENABLED_FLG', 'REPLICATION_ENABLED_FLG (1)', 'TABLE_NM']);
  assert.deepEqual(result.results, []);
  assert.equal(result.total, 0);
});

test('unique display labels do not collide with existing aliases', async () => {
  const state = setup(['ID', 'ID', 'ID (1)', 'ID'], [[1, 2, 3, 4]]);
  const page = await state.driver.fetchCursorPage(state.conn, sql, 0, 2);
  assert.deepEqual(page.cols, ['ID', 'ID (2)', 'ID (1)', 'ID (3)']);
  assert.deepEqual(Object.values(page.rows[0]), [1, 2, 3, 4]);
});

test('cursor is closed when fetching fails', async () => {
  const state = setup();
  state.conn.execute = async () => ({
    metaData: [{ name: 'ID' }],
    resultSet: {
      getRows: async () => { throw new Error('NJS-501: connection lost'); },
      close: async () => { state.wasClosed = true; },
    },
  });
  await assert.rejects(state.driver.fetchCursorPage(state.conn, sql, 0, 2), /NJS-501/);
  assert.equal(state.wasClosed, true);
});

test('an ambiguous original SELECT remains an error and is not rewritten', async () => {
  const state = setup();
  state.conn.execute = async query => {
    state.calls.push({ query });
    if (query.includes('DBMS_OUTPUT.ENABLE')) return {};
    throw Object.assign(new Error('ORA-00918: column ambiguously defined'), { errorNum: 918 });
  };
  const write = fs.writeFileSync;
  fs.writeFileSync = () => {};
  try {
    const [result] = await state.driver.query(sql, { pageSize: 2 });
    assert.equal(result.error, true);
    assert.match(result.messages.map(message => message.message).join('\n'), /ORA-00918/);
    assert.equal(state.calls.filter(call => call.query === sql).length, 1);
  } finally {
    fs.writeFileSync = write;
  }
});

test('network errors in the pagination wrapper are not retried', async () => {
  const state = setup();
  state.conn.execute = async query => {
    state.calls.push({ query });
    if (query.includes('DBMS_OUTPUT.ENABLE')) return {};
    throw new Error('NJS-501: read ECONNRESET');
  };
  state.driver.discardConnection = async () => {};
  const write = fs.writeFileSync;
  fs.writeFileSync = () => {};
  try {
    const [result] = await state.driver.query(sql, { pageSize: 2 });
    assert.equal(result.error, true);
    assert.equal(state.calls.filter(call => call.query === sql).length, 0);
  } finally {
    fs.writeFileSync = write;
  }
});
