const assert = require('node:assert/strict');
const { test } = require('node:test');
const serverless = require('serverless-http');
const { createApp } = require('../app');
const { createDatabaseConnection, connectionErrorMessage } = require('../db');

function event(path, method = 'GET', body) {
  const url = new URL(path, 'http://localhost');
  return { httpMethod: method, path: url.pathname, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body),
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

test('Invalid queries and update/delete methods never reach MongoDB', async () => {
  const handle = serverless(createApp(async () => { assert.fail('Database should not be accessed'); }));
  for (const path of ['/api/ingredients?storage=invalid', '/api/ingredients?name=', '/api/ingredients?name=eggs&name=rice']) {
    assert.equal((await handle(event(path), {})).statusCode, 400);
  }
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
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

test('The actual Netlify entrypoint can reject an invalid query without database configuration', async () => {
  const context = {};
  const response = await require('../netlify/functions/api').handler(event('/api/ingredients?storage=invalid'), context);
  assert.equal(response.statusCode, 400);
  assert.equal(context.callbackWaitsForEmptyEventLoop, false);
});

test('POST inserts only validated fields, trims text, and converts expiry to a UTC Date', async () => {
  let written;
  const handle = serverless(createApp(async () => ({
    async insertOne(record) { written = record; return { insertedId: 'created-id' }; }
  })));
  const response = await handle(event('/api/ingredients', 'POST', {
    name: '  Test ingredient  ', quantity: 1.5, unit: '  grams  ', storage: 'pantry',
    expiryDate: '2028-02-29', _id: 'untrusted-id', extra: 'ignored'
  }), {});
  assert.equal(response.statusCode, 201);
  assert.deepEqual(written, { name: 'Test ingredient', quantity: 1.5, unit: 'grams', storage: 'pantry', expiryDate: new Date('2028-02-29T00:00:00.000Z') });
  assert.deepEqual(JSON.parse(response.body), { ...written, expiryDate: '2028-02-29T00:00:00.000Z', _id: 'created-id' });
});

test('POST stores missing or empty expiry dates as null', async () => {
  const records = [];
  const handle = serverless(createApp(async () => ({
    async insertOne(record) { records.push(record); return { insertedId: 'created-id' }; }
  })));
  for (const expiry of [{}, { expiryDate: '' }, { expiryDate: null }]) {
    const response = await handle(event('/api/ingredients', 'POST', { name: 'Test', quantity: 2, unit: 'pieces', storage: 'fridge', ...expiry }), {});
    assert.equal(response.statusCode, 201);
    assert.equal(records.at(-1).expiryDate, null);
  }
});

test('POST rejects invalid fields before making any database request', async () => {
  const handle = serverless(createApp(async () => { assert.fail('Invalid inputs must not reach the database'); }));
  const valid = { name: 'Test', quantity: 1, unit: 'pieces', storage: 'fridge' };
  for (const body of [
    undefined, null, [], {}, { ...valid, name: ' ' }, { ...valid, name: {} }, { ...valid, name: 'x'.repeat(101) },
    { ...valid, quantity: 0 }, { ...valid, quantity: -1 }, { ...valid, quantity: '2' }, { ...valid, quantity: null },
    { ...valid, unit: '' }, { ...valid, unit: ['pieces'] }, { ...valid, unit: 'x'.repeat(41) },
    { ...valid, storage: 'cupboard' }, { ...valid, storage: { $ne: null } },
    ...['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-01-01T12:00:00Z', 'yesterday', 123].map(expiryDate => ({ ...valid, expiryDate }))
  ]) {
    const response = await handle(event('/api/ingredients', 'POST', body), {});
    assert.equal(response.statusCode, 400);
    assert.equal(typeof JSON.parse(response.body).error, 'string');
  }
});

test('POST returns helpful 400 responses for malformed or oversized JSON', async () => {
  const handle = serverless(createApp(async () => { assert.fail('Invalid JSON must not reach the database'); }));
  for (const body of ['{"name":', JSON.stringify({ name: 'x'.repeat(11000) })]) {
    const request = event('/api/ingredients', 'POST', {});
    request.body = body;
    const response = await handle(request, {});
    assert.equal(response.statusCode, 400);
    assert.equal(typeof JSON.parse(response.body).error, 'string');
  }
});
