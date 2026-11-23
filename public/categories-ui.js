(() => {
  let categories = [];
  let loaded = false;
  let busy = false;
  let loadVersion = 0;
  const section = document.querySelector('#categories-settings');
  const dialog = document.querySelector('#settings-dialog');
  const message = document.querySelector('#categories-message');
  const list = document.querySelector('#categories-list');
  const form = document.querySelector('#category-management-form');
  const name = document.querySelector('#category-name');
  const createMessage = document.querySelector('#category-create-message');
  const retry = document.querySelector('#categories-retry');
  const rows = new Map();
  function status(node, text, error = false) {
    node.textContent = text;
    node.className = 'form-message ' + (error ? 'error' : 'success');
  }
  function set(select, value) {
    const filter = select.hasAttribute('data-category-filter');
    const wanted = value == null ? '' : String(value);
    select.replaceChildren();
    function option(value,text) { const node=document.createElement('option');node.value=value;node.textContent=text;select.append(node); }
    if (filter) option('', 'All categories');
    option(filter ? 'null' : '', 'Uncategorized');
    for (const category of categories) option(category._id,category.name);
    // An Edit sheet can open before the initial request finishes. Retain its
    // reference until the API options arrive; saving is blocked while loading.
    if (!loaded && wanted && ![...select.options].some(option=>option.value===wanted)) option(wanted,'Loading category…');
    select.value = [...select.options].some(option=>option.value===wanted) ? wanted : '';
  }
  async function refresh() {
    const version = ++loadVersion;
    const response = await fetch('/api/categories', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.categories)) throw Error(data.error || 'Unable to load categories.');
    if (version !== loadVersion) return;
    categories = data.categories;
    loaded = true;
    for (const select of document.querySelectorAll('[data-category],[data-category-filter]')) set(select, select.value);
    render();
  }
  function button(text, action, danger = false) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'button secondary' + (danger ? ' danger' : '');
    node.textContent = text;
    if (action) node.addEventListener('click', action);
    return node;
  }
  function feedback(id) {
    const node = document.createElement('p');
    node.id = id;
    node.className = 'form-message';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    return node;
  }
  function syncControls() {
    section.setAttribute('aria-busy', String(busy));
    for (const control of section.querySelectorAll('button,input')) control.disabled = busy;
    dialog.querySelector('[data-close]').disabled = busy;
  }
  function render() {
    const fallback = document.createElement('li');
    fallback.textContent = 'Uncategorized · built-in';
    const current = new Set(categories.map(category => category._id));
    for (const id of rows.keys()) if (!current.has(id)) rows.delete(id);
    const nodes = categories.map(category => {
      if (!rows.has(category._id)) rows.set(category._id, categoryRow(category));
      const row = rows.get(category._id);
      row.category = category;
      row.label.textContent = category.name;
      row.rename.setAttribute('aria-label', 'Rename ' + category.name);
      row.remove.setAttribute('aria-label', 'Delete ' + category.name);
      return row.node;
    });
    // Reuse row DOM so refreshes never erase another category's rename draft.
    list.replaceChildren(fallback, ...nodes);
    syncControls();
  }
  async function run(work, targetMessage = message, focusAfter) {
    if (busy) return;
    busy = true;
    syncControls();
    try { await work(); }
    catch (error) {
      status(targetMessage, error instanceof TypeError || error instanceof SyntaxError
        ? 'Unable to confirm the change. Refresh categories before retrying.' : error.message, true);
    } finally {
      busy = false;
      syncControls();
      // Do not steal focus if the user moved to Units during a category request.
      if (dialog.open && (document.activeElement === document.body || section.contains(document.activeElement))) focusAfter?.()?.focus();
    }
  }
  async function request(path, method, body) {
    const response = await fetch('/api/categories' + path, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw Error(data?.error || 'Unable to save categories.');
    return data;
  }
  async function changed() {
    await refresh();
    await globalThis.kitchenUI.refreshAll();
  }
  function categoryRow(category) {
    const row = { category };
    row.node = document.createElement('li');
    row.node.className = 'category-manager-row';
    const header = document.createElement('div');
    header.className = 'category-row-header';
    row.label = document.createElement('span');
    row.editor = document.createElement('form');
    row.editor.className = 'category-inline-form';
    row.editor.hidden = true;
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = 'rename-category-' + category._id;
    label.textContent = 'Category name';
    row.input = document.createElement('input');
    row.input.id = label.htmlFor;
    row.input.required = true;
    row.input.maxLength = 100;
    row.input.autocomplete = 'off';
    row.input.setAttribute('aria-describedby', 'category-message-' + category._id);
    field.append(label, row.input);
    const actions = document.createElement('div');
    actions.className = 'category-inline-actions';
    const save = button('Save name');
    save.type = 'submit';
    const cancel = button('Cancel rename', () => {
      row.editor.hidden = true;
      status(row.message, '');
      row.rename.focus();
    });
    actions.append(save, cancel);
    row.editor.append(field, actions);
    row.confirmation = document.createElement('div');
    row.confirmation.className = 'category-delete-confirmation';
    row.confirmation.hidden = true;
    row.confirmation.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        row.confirmation.hidden = true;
        status(row.message, '');
        row.remove.focus();
      }
    });
    row.editor.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); cancel.click(); }
    });
    row.rename = button('Rename', () => {
      if (busy) return;
      row.confirmation.hidden = true;
      if (row.editor.hidden) row.input.value = row.category.name;
      row.editor.hidden = false;
      row.input.setCustomValidity('');
      status(row.message, '');
      row.input.focus();
    });
    row.remove = button('Delete', () => previewDelete(row), true);
    row.message = feedback('category-message-' + category._id);
    row.input.addEventListener('input', () => row.input.setCustomValidity(''));
    row.editor.addEventListener('submit', event => {
      event.preventDefault();
      row.input.setCustomValidity(row.input.value.trim() ? '' : 'Enter a category name.');
      if (!row.editor.reportValidity()) return;
      run(async () => {
        status(row.message, 'Saving name…');
        await request('/' + row.category._id, 'PUT', { name: row.input.value.trim() });
        row.editor.hidden = true;
        await changed();
        status(row.message, 'Category renamed.');
      }, row.message, () => row.editor.hidden ? row.rename : row.input);
    });
    header.append(row.label, row.rename, row.remove);
    row.node.append(header, row.editor, row.confirmation, row.message);
    return row;
  }
  async function previewDelete(row) {
    let confirm;
    await run(async () => {
      status(row.message, 'Checking category usage…');
      const detail = await request('/' + row.category._id, 'GET');
      row.confirmation.replaceChildren();
      row.confirmation.hidden = false;
      const text = document.createElement('p');
      text.textContent = 'Delete “' + detail.name + '”? ' + detail.inventoryCount + ' inventory record(s) and ' + detail.shoppingCount + ' shopping item(s) will become Uncategorized. No items will be deleted.';
      const actions = document.createElement('div');
      actions.className = 'category-inline-actions';
      confirm = button('Confirm delete', () => run(async () => {
        status(row.message, 'Deleting category…');
        const index = categories.findIndex(category => category._id === row.category._id);
        try {
          await request('/' + row.category._id, 'DELETE', { name: detail.name, inventoryCount: detail.inventoryCount, shoppingCount: detail.shoppingCount });
          await changed();
          status(message, 'Deleted “' + detail.name + '”. Its items are now Uncategorized.');
          row.focusAfterDelete = rows.get(categories[index]?._id)?.remove || name;
        } finally {
          // A failed/stale deletion needs a fresh usage review before retrying.
          row.confirmation.hidden = true;
        }
      }, row.message, () => row.focusAfterDelete || row.remove), true);
      const abort = button('Cancel', () => {
        row.confirmation.hidden = true;
        status(row.message, '');
        row.remove.focus();
      });
      actions.append(confirm, abort);
      row.confirmation.append(text, actions);
      syncControls();
      status(row.message, 'Review the category usage before confirming.');
    }, row.message, () => confirm || row.remove);
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    name.setCustomValidity(name.value.trim() ? '' : 'Enter a category name.');
    if (!form.reportValidity()) return;
    run(async () => {
      status(createMessage, 'Saving category…');
      await request('', 'POST', { name: name.value.trim() });
      name.value = '';
      await changed();
      status(createMessage, 'Category created.');
    }, createMessage, () => name);
  });
  name.addEventListener('input', () => name.setCustomValidity(''));
  retry.addEventListener('click', () => run(async () => {
    status(message, 'Loading categories…');
    await refresh();
    await globalThis.kitchenUI.refreshAll();
    status(message, 'Categories refreshed.');
  }, message, () => retry));
  document.querySelector('#settings-button').addEventListener('click', () => run(async () => {
    status(message, 'Loading categories…');
    await refresh();
    status(message, '');
  }));
  globalThis.categoryUI = { set, available: () => loaded, refresh, busy: () => busy };
  const initialVersion = loadVersion + 1;
  refresh().catch(() => {
    if (loadVersion !== initialVersion) return;
    loaded = false;
    status(message, 'Unable to load categories. Try Refresh categories.', true);
    globalThis.kitchenUI.toast('Unable to load categories. Retry in Settings → Categories.', true);
  });
})();
