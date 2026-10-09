const assert = require('node:assert/strict');
const { test } = require('node:test');
const queries = require('../out/ls/queries').default;

test('catalog tables bypass the display cap but normal lookups retain it', () => {
  assert.match(queries.searchTables({ search: '' }), /rownum <= 1500/);
  assert.doesNotMatch(queries.searchTables({ search: '', completionCatalog: true }), /rownum <=/);
});

test('complete columns are scoped to the owner and table with escaped literals', () => {
  const sql = queries.searchColumns({
    search: '', completionCatalog: true, tables: [{ label: "emp'loyee", schema: "app's" }],
  });
  assert.match(sql, /t.TABLE_NAME = 'EMP''LOYEE' AND t.OWNER = 'APP''S'/);
  assert.doesNotMatch(sql, /rownum <=/);
  assert.match(queries.searchColumns({ search: '', tables: [{ label: 'EMPLOYEE' }] }), /rownum <= 1500/);
});
