const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHarness, flush } = require('./frontend-harness.cjs');

const reply = (body, ok = true) => ({ ok, async json() { return body; } });
const sample = { _id: 'sample', name: '<img src=x onerror=alert(1)>', quantity: 2, unit: 'pieces', storage: 'fridge', expiryDate: '2026-12-31T00:00:00.000Z' };

test('Frontend shows loading, then empty state, and clears busy state', async () => {
  let resolve;
  const h = createHarness(() => new Promise(done => { resolve = done; }));
  assert.match(h.nodes['list-message'].textContent, /Loading/);
  assert.equal(h.nodes['ingredient-list'].attributes['aria-busy'], 'true');
  assert.equal(h.nodes['refresh-button'].disabled, true);
  resolve(reply({ ingredients: [] }));
  await flush();
  assert.match(h.nodes['list-message'].textContent, /first ingredient/);
  assert.equal(h.nodes['ingredient-count'].textContent, '0');
  assert.equal(h.nodes['ingredient-list'].attributes['aria-busy'], 'false');
});

test('Frontend renders all fields as text and offers recovery after a failed read', async () => {
  let fail = true;
  const h = createHarness(async () => fail ? reply({}, false) : reply({ ingredients: [sample] }));
  await flush();
  assert.match(h.nodes['list-message'].textContent, /Unable to load/);
  assert.equal(h.nodes['list-message'].className, 'list-message error');
  fail = false;
  await h.nodes['refresh-button'].listeners.click();
  const card = h.nodes['ingredient-cards'].children[0];
  for (const text of [sample.name, '2', 'pieces', 'Fridge', '2026']) assert.ok(card.textContent.includes(text));
  assert.equal(card.children[0].children[0].textContent, sample.name, 'User text is not inserted as HTML');
  assert.equal(h.nodes['list-message'].textContent, '');
});

test('Frontend prevents duplicate submits, sends JSON, resets after save, and refreshes the list', async () => {
  let resolvePost;
  const calls = [];
  let saved = false;
  const h = createHarness(async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return new Promise(resolve => { resolvePost = resolve; });
    return reply({ ingredients: saved ? [sample] : [] });
  });
  await flush();
  Object.assign(h.form.elements.name, { value: '  Test  ' });
  h.form.elements.quantity.value = '2';
  h.form.elements.unit.value = 'pieces';
  const first = h.submit();
  assert.equal(h.nodes['save-button'].disabled, true);
  assert.equal(h.nodes['save-button'].textContent, 'Saving…');
  await h.submit();
  const posts = calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/ingredients');
  assert.deepEqual(JSON.parse(posts[0].options.body), { name: 'Test', quantity: 2, unit: 'pieces', storage: 'fridge', expiryDate: null });
  saved = true;
  resolvePost(reply({ ...sample, name: 'Test' }));
  await first;
  assert.equal(h.form.resetCount, 1);
  assert.equal(h.form.elements.name.value, '');
  assert.match(h.nodes['form-message'].textContent, /Your ingredient is saved/);
  assert.equal(h.nodes['save-button'].disabled, false);
  assert.equal(h.nodes['ingredient-cards'].children.length, 1);
});

test('Frontend retains entered values after a server validation error', async () => {
  const h = createHarness(async (url, options) => options.method === 'POST' ? reply({ error: 'Name is required.' }, false) : reply({ ingredients: [] }));
  await flush();
  h.form.elements.name.value = ' ';
  h.form.elements.quantity.value = '1';
  await h.submit();
  assert.equal(h.form.elements.name.value, ' ');
  assert.equal(h.form.resetCount, undefined);
  assert.equal(h.nodes['form-message'].textContent, 'Name is required.');
  assert.equal(h.nodes['form-message'].className, 'form-message error');
  assert.equal(h.nodes['save-button'].disabled, false);
});

test('Frontend rejects zero quantity without sending a create request', async () => {
  let requests = 0;
  const h = createHarness(async () => { requests++; return reply({ ingredients: [] }); });
  await flush();
  h.form.elements.quantity.value = '0';
  await h.submit();
  assert.equal(requests, 1, 'Only the initial GET should have been made');
  assert.match(h.form.elements.quantity.validationMessage, /greater than zero/);
});
