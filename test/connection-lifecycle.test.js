const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const OracleDriver = require('../out/ls/driver').default;

function setup(options = {}) {
  const driver = new OracleDriver({
    id: 'lifecycle', name: 'test', driver: 'Oracle', username: 'test',
    connectString: 'localhost/test', oracleOptions: options,
  }, async () => []);
  const connections = [];
  const settings = [];
  const lib = {
    getConnection: async config => {
      settings.push(config);
      const conn = {
        healthy: true, pings: 0, closes: 0,
        isHealthy() { return this.healthy; },
        async ping() { this.pings++; },
        async close() { this.closes++; },
        async execute() { return {}; },
      };
      connections.push(conn);
      return conn;
    },
  };
  Object.defineProperty(driver, 'lib', { value: lib });
  return { driver, connections, settings, lib };
}

test('concurrent opens share one session and enable Thin TCP keep-alive', async () => {
  const { driver, connections, settings } = setup();
  const [first, second] = await Promise.all([driver.open(), driver.open()]);
  assert.equal(first, second);
  assert.equal(connections.length, 1);
  assert.equal(settings[0].expireTime, 1);
  assert.equal(await driver.open(), first);
  assert.equal(first.pings, 1);
  await driver.close();
});

test('keep-alive can be disabled and rejects invalid intervals', async () => {
  const disabled = setup({ expireTime: 0 });
  await disabled.driver.open();
  assert.equal(disabled.settings[0].expireTime, 0);
  for (const expireTime of [-1, 1.5, '1']) {
    await assert.rejects(setup({ expireTime }).driver.open(), /non-negative integer/);
  }
});

test('a failed open can be retried without caching its rejected promise', async () => {
  const state = setup();
  const acquire = state.lib.getConnection;
  state.lib.getConnection = async () => { throw new Error('connection refused'); };
  await assert.rejects(state.driver.open(), /connection refused/);
  state.lib.getConnection = acquire;
  await state.driver.open();
  assert.equal(state.connections.length, 1);
});

test('unhealthy cached session is discarded without silently replacing transaction state', async () => {
  const { driver, connections } = setup();
  const conn = await driver.open();
  conn.healthy = false;
  await assert.rejects(driver.open(), /uncommitted changes/);
  assert.equal(driver.connection, null);
  assert.equal(conn.closes, 1);
  assert.equal(connections.length, 1);
  const replacement = await driver.open();
  assert.notEqual(replacement, conn);
});

test('idle-session ping failure clears the cache; a fresh explicit open works', async () => {
  const { driver } = setup();
  const conn = await driver.open();
  driver.lastConnectionUse = 0;
  conn.ping = async () => { throw new Error('NJS-501: read ECONNRESET'); };
  await assert.rejects(driver.open(), /query was not retried/);
  assert.equal(driver.connection, null);
  assert.notEqual(await driver.open(), conn);
});

test('ordinary Oracle SQL errors are not connection failures', () => {
  const { driver } = setup();
  assert.equal(driver.isConnectionFailure({ message: 'ORA-00900: invalid SQL statement' }), false);
  assert.equal(driver.isConnectionFailure({ message: 'NJS-500: connection was closed' }), true);
  assert.equal(driver.isConnectionFailure({ code: 'ECONNRESET' }), true);
});

test('query network failure clears session and never retries the statement', async () => {
  const { driver } = setup();
  const conn = await driver.open();
  let updates = 0;
  conn.execute = async sql => {
    if (/UPDATE employees/.test(sql)) {
      updates++;
      throw new Error('NJS-501: read ECONNRESET');
    }
    return {};
  };
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = () => {};
  try {
    const results = await driver.query('UPDATE employees SET name = NULL', { requestId: 'test' });
    assert.equal(updates, 1);
    assert.equal(driver.connection, null);
    assert.equal(results[0].error, true);
    assert.match(results[0].messages.map(item => item.message).join('\n'), /No statement was retried/);
    assert.doesNotMatch(results[0].messages.map(item => item.message).join('\n'), /undefined,undefined/);
  } finally {
    fs.writeFileSync = originalWrite;
  }
});

test('closing clears cached state even if the physical close fails', async () => {
  const { driver } = setup();
  const conn = await driver.open();
  conn.close = async () => { throw new Error('close failed'); };
  await assert.rejects(driver.close(), /close failed/);
  assert.equal(driver.connection, null);
  assert.notEqual(await driver.open(), conn);
});

test('each driver owns its pool and reuses it after a broken checked-out session', async () => {
  const state = setup();
  state.driver.credentials.oracleOptions = undefined;
  let created = 0;
  let closed = 0;
  state.lib.createPool = async options => {
    created++;
    assert.equal(options.expireTime, 1);
    return {
      getConnection: () => state.lib.getConnection(),
      close: async () => { closed++; },
    };
  };
  const conn = await state.driver.open();
  conn.healthy = false;
  await assert.rejects(state.driver.open(), /session was lost/);
  await state.driver.open();
  assert.equal(created, 1);
  await state.driver.close();
  assert.equal(closed, 1);
});

test('Thick connections do not receive the Thin-only expireTime option', async () => {
  const state = setup({ thickMode: true });
  state.lib.initOracleClient = () => {};
  await state.driver.open();
  assert.equal('expireTime' in state.settings[0], false);
});

test('connection schema exposes expireTime within oracleOptions', () => {
  const schema = require('../connection.schema.json');
  assert.equal(schema.properties.oracleOptions.properties.expireTime.default, 1);
  assert.equal(schema.properties.expireTime, undefined);
});
