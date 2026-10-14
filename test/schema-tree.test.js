const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ContextValue } = require('@sqltools/types');
const OracleDriver = require('../out/ls/driver').default;
const queries = require('../out/ls/queries').default;

test('connections list schemas, then schema-scoped tables, views and columns', async () => {
  const driver = new OracleDriver({ id: 'tree', name: 'test', driver: 'Oracle' }, async () => []);
  const schemas = [{ label: 'MDA_00', schema: 'MDA_00', type: ContextValue.SCHEMA }];
  const tables = [{ label: 'EMPLOYEES', schema: 'MDA_00', type: ContextValue.TABLE }];
  const statements = [];
  driver.queryResults = async sql => {
    statements.push(sql);
    if (sql.includes('from all_users')) return schemas;
    if (sql.includes('from all_tables')) return tables;
    return [];
  };
  for (const type of [ContextValue.CONNECTION, ContextValue.CONNECTED_CONNECTION]) {
    assert.deepEqual(await driver.getChildrenForItem({ item: { type } }), schemas);
  }
  assert.match(statements[0], /order by decode\(u.username,user,0,1\), u.username/);
  assert.match(statements[0], /'group-by-ref-type' as "iconId"/);
  const groups = await driver.getChildrenForItem({ item: schemas[0] });
  assert.deepEqual(groups.map(group => group.label), ['Tables', 'Views']);
  assert.deepEqual(await driver.getChildrenForItem({ item: groups[0], parent: schemas[0] }), tables);
  assert.match(statements.at(-1), /t.owner = 'MDA_00'/);
  await driver.getChildrenForItem({ item: groups[1], parent: schemas[0] });
  assert.match(statements.at(-1), /from all_views t\s+where t.owner = 'MDA_00'/);
  for (const type of [ContextValue.TABLE, ContextValue.VIEW]) {
    await driver.getChildrenForItem({ item: { ...tables[0], type } });
    assert.match(statements.at(-1), /t.TABLE_NAME = 'EMPLOYEES'\s+AND t.OWNER = 'MDA_00'/);
  }
});

test('schema catalog names preserve case and escape literals in metadata queries', () => {
  const schema = { label: "Mixed'Owner", schema: "Mixed'Owner" };
  for (const query of [queries.fetchTables, queries.fetchViews]) {
    assert.match(query(schema), /t.owner = 'Mixed''Owner'/);
    assert.match(query({ label: 'MDA_00' }), /t.owner = 'MDA_00'/);
  }
  const table = { label: "Mixed'Table", schema: schema.schema };
  assert.match(queries.fetchColumns(table), /t.TABLE_NAME = 'Mixed''Table'/);
  assert.match(queries.fetchColumns(table), /t.OWNER = 'Mixed''Owner'/);
  assert.match(queries.describeTable(table), /from all_tab_columns/);
  assert.match(queries.describeTable(table), /t.OWNER = 'Mixed''Owner'/);
  assert.match(queries.describeTable({ label: 'EMPLOYEES' }), /t.OWNER = USER/);
});

test('record actions qualify the selected owner and escape quoted identifiers', () => {
  const table = { label: 'Mixed"Table', schema: 'Mixed"Owner' };
  for (const query of [queries.fetchRecords, queries.countRecords]) {
    assert.match(query({ table }), /FROM "Mixed""Owner"\."Mixed""Table"/);
    assert.match(query({ table: { label: 'EMPLOYEES' } }), /FROM EMPLOYEES/);
  }
});
