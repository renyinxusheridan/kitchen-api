const assert = require('node:assert/strict');
const { test } = require('node:test');
const serverless = require('serverless-http');
const databaseModule = require('../db');
const { memoryDatabase } = require('./memory-db.cjs');
const memory = memoryDatabase();
databaseModule.getDatabase = async () => memory.db;
databaseModule.withTransaction = work => memory.transact(work);
const { legacyLocations } = require('../storage');
memory.reset({storage_locations:Object.entries(legacyLocations).map(([legacyKey,location])=>({...location,legacyKey,nameKey:location.name.toLowerCase(),revision:0}))});
const { createApp } = require('../app');
const { createDatabaseConnection, connectionErrorMessage } = require('../db');
const { ObjectId } = require('mongodb');

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
      return { sort() { return this; }, limit() { return this; }, async toArray() { return [{ _id: 'example', name: 'Eggs', quantity: 2, unit: 'pieces', storage: 'fridge' }]; } };
    }
  })));
  for (const [path, filter] of [
    ['/api/ingredients', {}],
    ['/api/ingredients?name=eggs', { name: { $regex: 'eggs', $options: 'i' } }],
    ['/api/ingredients?storage=fridge', {}],
    ['/api/ingredients?name=.%2A&storage=fridge', { name: { $regex: '\\.\\*', $options: 'i' } }]
  ]) {
    const response = await handle(event(path), {});
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).count, 1);
    assert.deepEqual(seen.at(-1), filter);
  }
});

const ingredientId = '507f1f77bcf86cd799439011';
const validEdit = { name: '  Edited test  ', quantity: 3.5, unit: '  grams  ', storage: 'freezer', expiryDate: '2028-02-29' };

test('PUT edits the selected batch and name without replacing the ingredient or extra fields', async () => {
  const handle = serverless(createApp(async () => ({
    async findOne() { return {_id:new ObjectId(ingredientId),name:'Original',quantity:2,unit:'pieces',storage:'fridge',extra:'preserve'}; },
    async findOneAndUpdate(filter, update, options) {
      assert.ok(filter._id instanceof ObjectId);
      assert.equal(filter._id.toHexString(), ingredientId);
      assert.equal(update.$set.name, validEdit.name);
      assert.equal(update.$set.batches.length,1);
      assert.equal(update.$set.batches[0].quantity,3.5);
      assert.equal(update.$set.batches[0].unit,'grams');
      assert.equal(String(update.$set.batches[0].storageId),String(legacyLocations.freezer._id));
      assert.deepEqual(update.$set.batches[0].expiryDate,new Date('2028-02-29T00:00:00.000Z'));
      assert.ok(!Object.hasOwn(update.$set,'extra'));
      assert.equal(options.upsert,false);
      return { _id: filter._id, ...update.$set, preserved: true };
    }
  })));
  const response = await handle(event('/api/ingredients/' + ingredientId, 'PUT', { ...validEdit, _id: 'untrusted', $set: { quantity: 999 }, extra: true }), {});
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body)._id, ingredientId);
  assert.equal(JSON.parse(response.body).preserved, true);
});

test('PUT can clear expiry and accepts a successful unchanged update', async () => {
  const handle = serverless(createApp(async () => ({
    async findOne() { return {_id:new ObjectId(ingredientId),name:'Original',quantity:2,unit:'pieces',storage:'fridge'}; },
    async findOneAndUpdate(filter, update) {
      assert.equal(update.$set.batches[0].expiryDate, null);
      return { _id: filter._id, ...update.$set };
    }
  })));
  for (const expiryDate of [undefined, null, '']) {
    const response = await handle(event('/api/ingredients/' + ingredientId, 'PUT', { ...validEdit, expiryDate }), {});
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).expiryDate, null);
  }
});

test('PUT and DELETE reject malformed IDs before accessing MongoDB', async () => {
  const handle = serverless(createApp(async () => { assert.fail('Invalid ID reached database'); }));
  for (const id of ['invalid', '507f1f77bcf86cd79943901', 'z'.repeat(24), '%7B%22%24ne%22%3Anull%7D']) {
    for (const method of ['PUT', 'DELETE']) {
      assert.equal((await handle(event('/api/ingredients/' + id, method, validEdit), {})).statusCode, 400);
    }
  }
});

test('PUT and DELETE return 404 for a missing record', async () => {
  const handle = serverless(createApp(async () => ({
    async findOne() { return null; },
    async findOneAndUpdate() { return null; },
    async deleteOne() { return { deletedCount: 0 }; }
  })));
  for (const method of ['PUT', 'DELETE']) {
    const response = await handle(event('/api/ingredients/' + ingredientId, method, validEdit), {});
    assert.equal(response.statusCode, 404);
    assert.match(JSON.parse(response.body).error, /not found/);
  }
});

test('DELETE targets exactly one ObjectId and waits for database success', async () => {
  let finish;
  const handle = serverless(createApp(async () => ({
    deleteOne(filter) {
      assert.deepEqual(Object.keys(filter), ['_id']);
      assert.equal(filter._id.toHexString(), ingredientId);
      return new Promise(resolve => { finish = resolve; });
    }
  })));
  let settled = false;
  const response = handle(event('/api/ingredients/' + ingredientId, 'DELETE'), {}).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish({ deletedCount: 1 });
  assert.equal((await response).statusCode, 204);
  assert.equal((await response).body, '');
});

test('Mutation failures return action-specific errors without exposing database details', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', message => logs.push(message));
  const handle = serverless(createApp(async () => { throw new Error('private-marker'); }));
  for (const [method, action] of [['POST', 'save'], ['PUT', 'save'], ['DELETE', 'delete']]) {
    const path = '/api/ingredients' + (method === 'POST' ? '' : '/' + ingredientId);
    const response = await handle(event(path, method, validEdit), {});
    assert.equal(response.statusCode, 500);
    assert.match(JSON.parse(response.body).error, new RegExp('Unable to ' + action));
    assert.ok(!response.body.includes('private-marker'));
  }
  assert.ok(!logs.join().includes('private-marker'));
});

test('Invalid queries and mutation methods without an ID never reach MongoDB', async () => {
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

test('POST preserves display names, trims units, validates fields and creates the original stock batch', async () => {
  let written;
  const handle = serverless(createApp(async () => ({
    async insertOne(record) { written = record; return { insertedId: 'created-id' }; }
  })));
  const response = await handle(event('/api/ingredients', 'POST', {
    name: '  Test ingredient  ', quantity: 1.5, unit: '  grams  ', storage: 'pantry',
    expiryDate: '2028-02-29', _id: 'untrusted-id', extra: 'ignored'
  }), {});
  assert.equal(response.statusCode, 201);
  assert.equal(written.name,'  Test ingredient  ');
  assert.equal(written.unit,'grams');
  assert.equal(written.extra,undefined);
  assert.notEqual(String(written._id),'untrusted-id');
  assert.equal(written.batches.length,1);
  assert.equal(written.batches[0].quantity,1.5);
  assert.deepEqual(written.batches[0].expiryDate,new Date('2028-02-29T00:00:00.000Z'));
  assert.equal(JSON.parse(response.body).expiryDate,'2028-02-29T00:00:00.000Z');
  assert.equal(JSON.parse(response.body).categoryName,'Uncategorized');
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

test('POST and PUT reject invalid fields before making any database request', async () => {
  const handle = serverless(createApp(async () => { assert.fail('Invalid inputs must not reach the database'); }));
  const valid = { name: 'Test', quantity: 1, unit: 'pieces', storage: 'fridge' };
  for (const body of [
    undefined, null, [], {}, { ...valid, name: ' ' }, { ...valid, name: {} }, { ...valid, name: 'x'.repeat(101) },
    { ...valid, quantity: 0 }, { ...valid, quantity: -1 }, { ...valid, quantity: '2' }, { ...valid, quantity: null },
    { ...valid, unit: '' }, { ...valid, unit: ['pieces'] }, { ...valid, unit: 'x'.repeat(41) },
    { ...valid, storage: 'cupboard' }, { ...valid, storage: { $ne: null } },
    ...['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-01-01T12:00:00Z', 'yesterday', 123].map(expiryDate => ({ ...valid, expiryDate }))
  ]) {
    for (const [path, method] of [['/api/ingredients', 'POST'], ['/api/ingredients/507f1f77bcf86cd799439011', 'PUT']]) {
      const response = await handle(event(path, method, body), {});
      assert.equal(response.statusCode, 400);
      assert.equal(typeof JSON.parse(response.body).error, 'string');
    }
  }
});

test('POST and PUT return helpful 400 responses for malformed or oversized JSON', async () => {
  const handle = serverless(createApp(async () => { assert.fail('Invalid JSON must not reach the database'); }));
  for (const body of ['{"name":', JSON.stringify({ name: 'x'.repeat(140000) })]) {
    for (const [path, method] of [['/api/ingredients', 'POST'], ['/api/ingredients/507f1f77bcf86cd799439011', 'PUT']]) {
      const request = event(path, method, {});
      request.body = body;
      const response = await handle(request, {});
      assert.equal(response.statusCode, 400);
      assert.equal(typeof JSON.parse(response.body).error, 'string');
    }
  }
});
