const assert = require('node:assert/strict');
const { test } = require('node:test');
const serverless = require('serverless-http');
const { createApp } = require('../app');
const { createDatabaseConnection, connectionErrorMessage } = require('../db');

function event(path, method = 'GET') {
  const url = new URL(path, 'http://localhost');
  return { httpMethod: method, path: url.pathname, headers: {}, body: null,
    queryStringParameters: Object.fromEntries(url.searchParams),
    multiValueQueryStringParameters: Object.fromEntries([...new Set(url.searchParams.keys())].map(key => [key, url.searchParams.getAll(key)])),
    isBase64Encoded: false };
}

test('Function adapter preserves ingredient paths and filters', async () => {
  const seen = [];
  const handle = serverless(createApp(async () => ({
    find(filter) {
      seen.push(filter);
      return { sort() { return this; }, limit() { return this; }, async toArray() { return [{ _id: 'example', name: 'Eggs' }]; } };
    }
  })));
  for (const [path, filter] of [
    ['/api/ingredients', {}],
    ['/api/ingredients?name=eggs', { name: { $regex: 'eggs', $options: 'i' } }],
    ['/api/ingredients?storage=fridge', { storage: 'fridge' }],
    ['/api/ingredients?name=.%2A&storage=fridge', { name: { $regex: '\\.\\*', $options: 'i' }, storage: 'fridge' }]
  ]) {
    const response = await handle(event(path), {});
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).count, 1);
    assert.deepEqual(seen.at(-1), filter);
  }
});

test('Invalid queries and write methods never reach MongoDB', async () => {
  const handle = serverless(createApp(async () => { assert.fail('Database should not be accessed'); }));
  for (const path of ['/api/ingredients?storage=invalid', '/api/ingredients?name=', '/api/ingredients?name=eggs&name=rice']) {
    assert.equal((await handle(event(path), {})).statusCode, 400);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await handle(event('/api/ingredients', method), {})).statusCode, 404);
  }
});

test('Database errors do not expose internal details to HTTP callers or logs', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', message => logs.push(message));
  const secret = 'sensitive-test-marker';
  const handle = serverless(createApp(async () => { throw new Error(secret); }));
  const response = await handle(event('/api/ingredients'), {});
  assert.equal(response.statusCode, 500);
  assert.ok(!response.body.includes(secret));
  assert.ok(!logs.join().includes(secret));
  assert.ok(!connectionErrorMessage({ code: 18, message: secret }).includes(secret));
});

test('Concurrent and subsequent invocations reuse one MongoClient and connection', async () => {
  let created = 0;
  let connected = 0;
  let closed = 0;
  const db = {};
  class Client {
    constructor() { created++; }
    async connect() { connected++; await Promise.resolve(); return this; }
    db(name) { assert.equal(name, 'kitchen_app'); return db; }
    async close() { closed++; }
  }
  const connection = createDatabaseConnection({ Client, env: { MONGODB_URI: 'mongodb://example.invalid' } });
  assert.equal(created, 0, 'Importing the module must not connect during a build');
  const first = connection.getDatabase();
  assert.equal(connection.getDatabase(), first);
  assert.deepEqual(await Promise.all([first, connection.getDatabase()]), [db, db]);
  assert.equal(await connection.getDatabase(), db);
  assert.equal(created, 1);
  assert.equal(connected, 1);
  assert.equal(closed, 0);
  await connection.close();
  assert.equal(closed, 1);
});

test('A failed first connection is closed and the next invocation can retry', async () => {
  let created = 0;
  let closed = 0;
  class Client {
    constructor() { this.attempt = ++created; }
    async connect() { if (this.attempt === 1) throw new Error('temporary failure'); return this; }
    db() { return 'connected'; }
    async close() { closed++; }
  }
  const connection = createDatabaseConnection({ Client, env: { MONGODB_URI: 'mongodb://example.invalid' } });
  await assert.rejects(connection.getDatabase(), /temporary failure/);
  assert.equal(closed, 1);
  assert.equal(await connection.getDatabase(), 'connected');
  assert.equal(created, 2);
  await connection.close();
});

test('The actual Netlify entrypoint can serve the root without database configuration', async () => {
  const context = {};
  const response = await require('../netlify/functions/api').handler(event('/'), context);
  assert.equal(response.statusCode, 200);
  assert.equal(context.callbackWaitsForEmptyEventLoop, false);
});
