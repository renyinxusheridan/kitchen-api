const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHarness, flush } = require('./frontend-harness.cjs');

const reply = (body, ok = true) => ({ ok, async json() { return body; } });
const sample = { _id: 'sample', name: '<img src=x onerror=alert(1)>', quantity: 2, unit: 'pieces', storage: 'fridge', expiryDate: '2026-12-31T00:00:00.000Z' };

test('Category controls fetch the API, show an empty match state, prefill and save category, and restore it on reload', async () => {
  let record = { ...sample, categoryId: '6b0500000000000000000003' };
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'PUT') {
      record = { ...record, ...JSON.parse(options.body) };
      return reply(record);
    }
    return reply({ ingredients: url.endsWith('categoryId=6b0500000000000000000001') ? [] : [record] });
  };
  const h = createHarness(fetch, { categories: true });
  await flush();
  h.nodes['category-filter'].value = '6b0500000000000000000001';
  await h.nodes['category-filter'].listeners.change();
  assert.equal(calls.at(-1).url, '/api/ingredients?categoryId=6b0500000000000000000001');
  assert.match(h.nodes['list-message'].textContent, /No ingredients match/);
  h.nodes['category-filter'].value = '';
  await h.nodes['category-filter'].listeners.change();
  button(h.nodes['ingredient-cards'], 'Edit').listeners.click();
  assert.equal(h.form.elements.categoryId.value, '6b0500000000000000000003');
  h.form.elements.categoryId.value = '6b0500000000000000000002';
  await h.submit();
  assert.equal(record.categoryId, '6b0500000000000000000002');
  const reloaded = createHarness(fetch, { categories: true });
  await flush();
  button(reloaded.nodes['ingredient-cards'], 'Edit').listeners.click();
  assert.equal(reloaded.form.elements.categoryId.value, '6b0500000000000000000002');
});

function button(node, text) {
  if (node.textContent === text && node.listeners.click) return node;
  for (const child of node.children) {
    const match = button(child, text);
    if (match) return match;
  }
}

test('An older refresh cannot replace cards during an edit or a deletion confirmation', async () => {
  for (const action of ['Edit', 'Delete']) {
    let reads = 0;
    let finishRefresh;
    const h = createHarness(async () => ++reads === 1 ? reply({ ingredients: [sample] }) : new Promise(resolve => { finishRefresh = resolve; }));
    await flush();
    const refreshing = h.nodes['refresh-button'].listeners.click();
    button(h.nodes['ingredient-cards'], action).listeners.click();
    finishRefresh(reply({ ingredients: [] }));
    await refreshing;
    assert.equal(h.nodes['ingredient-cards'].children.length, 1);
    assert.equal(h.nodes['ingredient-list'].attributes['aria-busy'], 'false');
    assert.equal(h.nodes['list-message'].textContent, '');
    if (action === 'Edit') assert.equal(h.form.elements.name.value, sample.name);
    else assert.ok(button(h.nodes['ingredient-cards'], 'Confirm delete'));
  }
});

test('Edit prefills all five fields and Cancel returns to Create without writing', async () => {
  let requests = 0;
  const h = createHarness(async () => { requests++; return reply({ ingredients: [sample] }); });
  await flush();
  button(h.nodes['ingredient-cards'], 'Edit').listeners.click();
  assert.equal(h.form.elements.name.value, sample.name);
  assert.equal(h.form.elements.quantity.value, sample.quantity);
  assert.equal(h.form.elements.unit.value, sample.unit);
  assert.equal(h.form.elements.storage.value, sample.storage);
  assert.equal(h.form.elements.expiryDate.value, '2026-12-31');
  assert.equal(h.nodes['save-button'].textContent, 'Save changes');
  h.form.elements.name.value = 'Cancelled edit';
  await h.nodes['refresh-button'].listeners.click();
  h.nodes['cancel-edit-button'].listeners.click();
  assert.equal(requests, 1);
  assert.equal(h.form.elements.name.value, '');
  assert.equal(h.nodes['cancel-edit-button'].hidden, true);
  assert.equal(h.nodes['add-heading'].textContent, 'Add an ingredient');
  assert.ok(h.nodes['ingredient-cards'].textContent.includes(sample.name));
});

test('Edit sends one PUT, blocks conflicting actions, and displays saved fields after a reload', async () => {
  let finish;
  let record = sample;
  const puts = [];
  const fetch = async (url, options) => {
    if (options.method === 'PUT') {
      puts.push({ url, options });
      return new Promise(resolve => { finish = resolve; });
    }
    return reply({ ingredients: [record] });
  };
  const h = createHarness(fetch);
  await flush();
  button(h.nodes['ingredient-cards'], 'Edit').listeners.click();
  Object.entries({ name: 'Updated', quantity: '4.5', unit: 'grams', storage: 'freezer', expiryDate: '' }).forEach(([key, value]) => { h.form.elements[key].value = value; });
  const first = h.submit();
  await h.submit();
  h.nodes['cancel-edit-button'].listeners.click();
  await h.nodes['refresh-button'].listeners.click();
  assert.equal(h.nodes['save-button'].textContent, 'Saving…');
  assert.equal(h.form.elements.name.disabled, true);
  assert.equal(button(h.nodes['ingredient-cards'], 'Delete').disabled, true);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, '/api/ingredients/sample');
  const body = JSON.parse(puts[0].options.body);
  assert.deepEqual(body, { name: 'Updated', quantity: 4.5, unit: 'grams', storage: 'freezer', expiryDate: null });
  record = { ...body, _id: sample._id };
  finish(reply(record));
  await first;
  assert.match(h.nodes['form-message'].textContent, /Updated.*saved/);
  assert.equal(h.form.elements.name.disabled, false);
  const reloaded = createHarness(fetch);
  await flush();
  for (const text of ['Updated', '4.5', 'grams', 'Freezer', 'Not set']) assert.ok(reloaded.nodes['ingredient-cards'].textContent.includes(text));
});

test('Edit failures retain every entered value and allow retrying the same record', async () => {
  for (const failure of ['server', 'network', 'json']) {
    let fail = true;
    let putCount = 0;
    const h = createHarness(async (url, options) => {
      if (options.method !== 'PUT') return reply({ ingredients: [sample] });
      putCount++;
      if (!fail) return reply({ ...sample, name: 'Keep me' });
      if (failure === 'network') throw new TypeError('offline');
      if (failure === 'json') return { ok: false, json() { throw new SyntaxError('invalid'); } };
      return reply({ error: 'Unable to save the ingredient.' }, false);
    });
    await flush();
    button(h.nodes['ingredient-cards'], 'Edit').listeners.click();
    const entered = { name: 'Keep me', quantity: '3', unit: 'bags', storage: 'pantry', expiryDate: '2028-02-29' };
    for (const [key, value] of Object.entries(entered)) h.form.elements[key].value = value;
    await h.submit();
    for (const [key, value] of Object.entries(entered)) assert.equal(h.form.elements[key].value, value);
    assert.equal(h.nodes['form-message'].className, 'form-message error');
    assert.equal(h.nodes['save-button'].disabled, false);
    assert.equal(h.nodes['save-button'].textContent, 'Save changes');
    assert.equal(h.form.resetCount, undefined);
    assert.ok(h.nodes['ingredient-cards'].textContent.includes(sample.name));
    fail = false;
    await h.submit();
    assert.equal(putCount, 2);
    assert.match(h.nodes['form-message'].textContent, /saved/);
  }
});

test('Delete names the ingredient, supports cancellation, waits for success, and prevents repeats', async () => {
  let finish;
  let deletes = 0;
  const other = { ...sample, _id: 'other', name: 'Preserved ingredient' };
  const h = createHarness(async (url, options) => {
    if (options.method !== 'DELETE') return reply({ ingredients: [sample, other] });
    assert.equal(url, '/api/ingredients/sample');
    deletes++;
    return new Promise(resolve => { finish = resolve; });
  });
  await flush();
  button(h.nodes['ingredient-cards'], 'Delete').listeners.click();
  assert.ok(h.nodes['ingredient-cards'].textContent.includes('Delete “' + sample.name + '”?'));
  button(h.nodes['ingredient-cards'], 'Cancel').listeners.click();
  assert.equal(deletes, 0);
  button(h.nodes['ingredient-cards'], 'Delete').listeners.click();
  const confirm = button(h.nodes['ingredient-cards'], 'Confirm delete');
  const first = confirm.listeners.click();
  await confirm.listeners.click();
  await h.submit();
  assert.equal(deletes, 1);
  assert.equal(confirm.textContent, 'Deleting…');
  assert.equal(h.nodes['ingredient-cards'].children.length, 2);
  finish(reply(null));
  await first;
  assert.equal(h.nodes['ingredient-cards'].children.length, 1);
  assert.ok(h.nodes['ingredient-cards'].textContent.includes(other.name));
  assert.equal(h.nodes['ingredient-count'].textContent, '1');
  assert.match(h.nodes['operation-message'].textContent, /Deleted/);
});

test('Delete failure keeps the card and supports retry; deleting the last card shows empty state', async () => {
  let fail = true;
  const h = createHarness(async (url, options) => options.method === 'DELETE'
    ? reply({ error: 'Unable to delete the ingredient.' }, !fail) : reply({ ingredients: [sample] }));
  await flush();
  button(h.nodes['ingredient-cards'], 'Delete').listeners.click();
  await button(h.nodes['ingredient-cards'], 'Confirm delete').listeners.click();
  assert.equal(h.nodes['ingredient-cards'].children.length, 1);
  assert.equal(h.nodes['operation-message'].className, 'form-message error');
  assert.equal(button(h.nodes['ingredient-cards'], 'Confirm delete').disabled, false);
  fail = false;
  await button(h.nodes['ingredient-cards'], 'Confirm delete').listeners.click();
  assert.equal(h.nodes['ingredient-count'].textContent, '0');
  assert.match(h.nodes['list-message'].textContent, /first ingredient/);
});

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
