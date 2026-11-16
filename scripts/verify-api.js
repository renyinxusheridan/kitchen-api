const assert = require('node:assert/strict');

async function verify() {
  const base = new URL(process.argv[2] || 'http://localhost:8888');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Supply an HTTP(S) origin without credentials or query parameters.');
  }
  const paths = ['/api/ingredients', '/api/ingredients?name=eggs', '/api/ingredients?storage=fridge'];
  const results = await Promise.all(paths.map(async (path) => {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30000) });
    console.log(path + ' -> HTTP ' + response.status);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.ingredients));
    assert.equal(body.count, body.ingredients.length);
    assert.ok(body.count > 0);
    assert.ok(body.ingredients.every(record => record._id && typeof record.name === 'string'));
    return body;
  }));
  const [all, eggs, fridge] = results;
  assert.ok(eggs.ingredients.every(record => /eggs/i.test(record.name)));
  assert.ok(fridge.ingredients.every(record => record.storage === 'fridge'));
  const ids = body => body.ingredients.map(record => record._id);
  if (all.count < all.limit) {
    assert.deepEqual(ids(eggs), all.ingredients.filter(record => /eggs/i.test(record.name)).map(record => record._id));
    assert.deepEqual(ids(fridge), all.ingredients.filter(record => record.storage === 'fridge').map(record => record._id));
  }
  const repeat = await fetch(new URL(paths[0], base), { signal: AbortSignal.timeout(30000) });
  assert.equal(repeat.status, 200);
  assert.deepEqual(ids(await repeat.json()), ids(all));
  assert.equal((await fetch(new URL('/api/ingredients?storage=invalid', base))).status, 400);
  const invalidCreate = await fetch(new URL('/api/ingredients', base), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: 0 })
  });
  assert.equal(invalidCreate.status, 400);
  assert.equal(typeof (await invalidCreate.json()).error, 'string');
  assert.equal((await fetch(new URL('/api/ingredients', base), { method: 'DELETE' })).status, 404);
  for (const method of ['PUT', 'DELETE']) {
    const invalidId = await fetch(new URL('/api/ingredients/invalid-id', base), { method });
    assert.equal(invalidId.status, 400);
    assert.equal(typeof (await invalidId.json()).error, 'string');
  }
  console.log(JSON.stringify({ all: all.count, eggs: eggs.count, fridge: fridge.count }));
  console.log('PASS: ingredient reads, both filters, repeat invocation, invalid create/storage, malformed update/delete IDs, and rejection of deletion without an ID. No records were changed.');
}

verify().catch(() => {
  console.error('Verification failed. Check that the API is running and inspect its credential-safe logs. No internal error details were printed.');
  process.exitCode = 1;
});
