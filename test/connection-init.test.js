const assert = require('node:assert/strict');
const { test } = require('node:test');
const OracleDriver = require('../out/ls/driver').default;

const script = `ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD';
ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS';`;

function setup(sql = script, pooled = false) {
  const driver = new OracleDriver({
    id: 'init', name: 'test', driver: 'Oracle', username: 'test',
    connectString: 'localhost/test', connectionInitSql: sql,
    ...(pooled ? {} : { oracleOptions: {} }),
  }, async () => []);
  const connections = [];
  const lib = {
    getConnection: async () => {
      const conn = {
        statements: [], closes: 0, commits: 0, rollbacks: 0,
        isHealthy: () => true,
        ping: async () => {},
        close: async () => { conn.closes++; },
        commit: async () => { conn.commits++; },
        rollback: async () => { conn.rollbacks++; },
        execute: async (sql, binds, options) => {
          conn.statements.push({ sql, options });
          if (sql.includes('COUNT(*)')) return { rows: [{ matching_count: 1 }] };
          return { rowsAffected: 1 };
        },
      };
      connections.push(conn);
      return conn;
    },
    createPool: async () => ({ getConnection: () => lib.getConnection(), close: async () => {} }),
  };
  Object.defineProperty(driver, 'lib', { value: lib });
  return { driver, connections, lib };
}

for (const pooled of [false, true]) {
  test(`${pooled ? 'pooled' : 'standalone'} session initializes once before cached reuse and again after reconnect`, async () => {
    const { driver, connections } = setup(script, pooled);
    const [first, second] = await Promise.all([driver.open(), driver.open()]);
    assert.equal(first, second);
    assert.equal(connections.length, 1);
    assert.deepEqual(first.statements.map(item => item.sql.trim()), script.split(';').map(sql => sql.trim()).filter(Boolean));
    assert.ok(first.statements.every(item => item.options.autoCommit === false));
    assert.equal(first.commits, 0);
    await driver.open();
    assert.equal(first.statements.length, 2);
    await driver.close();
    const replacement = await driver.open();
    assert.notEqual(replacement, first);
    assert.equal(replacement.statements.length, 2);
    await driver.close();
  });
}

test('empty and comment-only initialization scripts do not execute statements', async () => {
  for (const script of [undefined, '', ' \n ', '-- nothing\n/* comment */']) {
    const state = setup(script);
    // setup's default parameter is bypassed for the absent setting.
    state.driver.credentials.connectionInitSql = script;
    const conn = await state.driver.open();
    assert.equal(conn.statements.length, 0);
    await state.driver.close();
  }
});

test('script parsing preserves quoted semicolons and PL/SQL blocks', async () => {
  const { driver } = setup(`ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY;MM;DD';
BEGIN
  NULL;
  NULL;
END;
/
ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS';`);
  const conn = await driver.open();
  assert.equal(conn.statements.length, 3);
  assert.match(conn.statements[0].sql, /'YYYY;MM;DD'/);
  assert.match(conn.statements[1].sql, /BEGIN\s+NULL;\s+NULL;\s+END;/);
  assert.doesNotMatch(conn.statements[1].sql, /\/\s*$/);
  await driver.close();
});

test('failed initialization stops subsequent statements, closes the session and permits a later explicit retry', async () => {
  const state = setup(`${script}\nALTER SESSION SET CURRENT_SCHEMA = APP;`);
  const acquire = state.lib.getConnection;
  state.lib.getConnection = async () => {
    const conn = await acquire();
    const execute = conn.execute;
    conn.execute = async (...args) => {
      await execute(...args);
      if (conn.statements.length === 2) throw new Error('ORA-01821: date format not recognized');
      return {};
    };
    return conn;
  };
  await assert.rejects(state.driver.open(), /initialization SQL failed at statement 2: ORA-01821/);
  assert.equal(state.connections[0].statements.length, 2);
  assert.equal(state.connections[0].closes, 1);
  assert.equal(state.driver.connection, undefined);
  state.lib.getConnection = acquire;
  const conn = await state.driver.open();
  assert.equal(conn.statements.length, 3);
  await state.driver.close();
});

test('grid-edit session is initialized before validation and updates', async () => {
  const { driver, connections } = setup();
  const result = await driver.applyEdits([{
    table: { label: 'EMPLOYEES', schema: 'APP' },
    primaryKey: { ID: 1 }, changes: { NAME: 'new' },
  }]);
  assert.equal(result.success, true);
  assert.equal(connections.length, 2);
  const edit = connections[1];
  assert.match(edit.statements[0].sql, /NLS_DATE_FORMAT/);
  assert.match(edit.statements[1].sql, /NLS_TIMESTAMP_FORMAT/);
  assert.match(edit.statements[2].sql, /SELECT COUNT/);
  assert.match(edit.statements[3].sql, /UPDATE/);
  assert.equal(edit.commits, 1);
  assert.equal(edit.closes, 1);
  await driver.close();
});

test('settings expose an optional multiline initialization field', () => {
  const schema = require('../connection.schema.json');
  const ui = require('../ui.schema.json');
  assert.equal(schema.properties.connectionInitSql.type, 'string');
  assert.equal(schema.properties.connectionInitSql.default, '');
  assert.equal(ui.connectionInitSql['ui:widget'], 'textarea');
  assert.ok(ui['ui:order'].includes('connectionInitSql'));
});

test('grid-edit initialization failure prevents updates and closes only the edit session', async () => {
  const state = setup();
  const main = await state.driver.open();
  const acquire = state.lib.getConnection;
  state.lib.getConnection = async () => {
    const conn = await acquire();
    conn.execute = async sql => {
      conn.statements.push({ sql });
      throw new Error('ORA-01821: date format not recognized');
    };
    return conn;
  };
  const result = await state.driver.applyEdits([{
    table: { label: 'EMPLOYEES', schema: 'APP' },
    primaryKey: { ID: 1 }, changes: { NAME: 'new' },
  }]);
  assert.equal(result.success, false);
  assert.match(result.error, /initialization SQL failed at statement 1/);
  assert.equal(state.connections[1].statements.length, 1);
  assert.equal(state.connections[1].closes, 1);
  assert.equal(state.connections[1].commits, 0);
  assert.equal(await state.driver.open(), main);
  assert.equal(main.closes, 0);
  await state.driver.close();
});

test('initialization network failure is not automatically replayed', async () => {
  const state = setup();
  const acquire = state.lib.getConnection;
  state.lib.getConnection = async () => {
    const conn = await acquire();
    conn.execute = async sql => {
      conn.statements.push({ sql });
      throw new Error('NJS-501: read ECONNRESET');
    };
    return conn;
  };
  await assert.rejects(state.driver.open(), /initialization SQL failed at statement 1: NJS-501/);
  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].statements.length, 1);
  assert.equal(state.connections[0].closes, 1);
});
