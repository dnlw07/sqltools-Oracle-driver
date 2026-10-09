const assert = require('node:assert/strict');
const { test } = require('node:test');
const OracleDriver = require('../out/ls/driver').default;

function setup(rows = []) {
  const driver = new OracleDriver({
    id: 'empty-results', name: 'test', driver: 'Oracle',
  }, async () => []);
  driver.open = async () => ({
    execute: async sql => {
      if (sql.includes('DBMS_OUTPUT.GET_LINE')) return { outBinds: { st: 1 } };
      if (sql.includes('DBMS_OUTPUT.ENABLE')) return {};
      if (sql.includes('COUNT(*)')) return { rows: [{ SQLTOOLS_TOTAL: rows.length }] };
      return { rows, metaData: [{ name: 'EMPLOYEE_ID' }, { name: 'DisplayName' }] };
    },
  });
  driver.resolveResultEditability = async () => ({ editable: false });
  return driver;
}

for (const internal of [false, true]) {
  test(`empty ${internal ? 'regular' : 'paginated'} SELECT preserves metadata names and casing`, async () => {
    const [result] = await setup().query('SELECT * FROM employees', {
      requestId: 'request', __internal: internal,
    });
    assert.deepEqual(result.cols, ['EMPLOYEE_ID', 'DisplayName']);
    assert.deepEqual(result.results, []);
    assert.match(result.messages[0].message, /0 rows/);
    if (!internal) {
      assert.equal(result.page, 0);
      assert.equal(result.total, 0);
    }
  });
}

test('populated SELECT retains data with metadata-derived headers', async () => {
  const rows = [{ EMPLOYEE_ID: 1, DisplayName: 'Test' }];
  const [result] = await setup(rows).query('SELECT * FROM employees', { __internal: true });
  assert.deepEqual(result.cols, ['EMPLOYEE_ID', 'DisplayName']);
  assert.deepEqual(result.results, rows);
});
