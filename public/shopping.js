(() => {
  const form = document.querySelector('#shopping-form');
  const saveButton = document.querySelector('#shopping-save');
  const cancelEditButton = document.querySelector('#shopping-cancel-edit');
  const formHeading = document.querySelector('#shopping-form-heading');
  const formMessage = document.querySelector('#shopping-form-message');
  const refreshButton = document.querySelector('#shopping-refresh');
  const list = document.querySelector('#shopping-list');
  const listMessage = document.querySelector('#shopping-list-message');
  const cards = document.querySelector('#shopping-cards');
  const count = document.querySelector('#shopping-count');
  const operationMessage = document.querySelector('#shopping-operation-message');
  const fields = ['name', 'plannedQuantity', 'unit'];
  const endpoint = '/api/shopping-items';
  let items = [];
  let editing = null;
  let pendingDelete = null;
  let saving = false;
  let deleting = false;
  let loading = false;
  let loadVersion = 0;
  let cardButtons = [];
  let confirmationButton;

  function message(node, text, state = '') {
    node.className = 'form-message' + (state ? ' ' + state : '');
    node.textContent = text;
  }

  function syncControls() {
    const busy = saving || deleting;
    const active = busy || editing !== null || pendingDelete !== null;
    refreshButton.disabled = loading || active;
    saveButton.disabled = busy || pendingDelete !== null;
    cancelEditButton.disabled = busy;
    for (const key of fields) form.elements[key].disabled = busy || pendingDelete !== null;
    for (const button of cardButtons) button.disabled = active;
  }

  function discardOlderLoad() {
    ++loadVersion;
    loading = false;
    list.setAttribute('aria-busy', 'false');
  }

  function finishEditing() {
    editing = null;
    form.reset();
    for (const key of fields) form.elements[key].setCustomValidity('');
    formHeading.textContent = 'Add a shopping item';
    saveButton.textContent = '+ Add shopping item';
    cancelEditButton.hidden = true;
    syncControls();
  }

  function startEditing(item) {
    if (saving || deleting || editing || pendingDelete) return;
    editing = item;
    discardOlderLoad();
    formHeading.textContent = 'Edit a shopping item';
    for (const key of fields) {
      form.elements[key].value = item[key];
      form.elements[key].setCustomValidity('');
    }
    saveButton.textContent = 'Save changes';
    cancelEditButton.hidden = false;
    message(formMessage, 'Editing “' + item.name + '”.');
    message(operationMessage, '');
    renderItems();
    form.elements.name.focus();
  }

  // Render user-defined names and units as text, never as HTML.
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, className, onClick) {
    const node = element('button', 'button secondary' + (className ? ' ' + className : ''), text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function renderItems() {
    cardButtons = [];
    cards.replaceChildren(...items.map(itemCard));
    count.textContent = items.length;
    listMessage.className = 'list-message';
    listMessage.textContent = items.length ? '' : 'Your shopping list is empty. Add your first item using the form.';
    syncControls();
  }

  function itemCard(item) {
    const card = element('li', 'ingredient-card');
    const header = element('div', 'card-header');
    header.append(element('h3', '', item.name));
    const amount = element('p', 'amount', String(item.plannedQuantity));
    amount.append(element('span', '', item.unit));
    card.append(header, amount, element('p', 'expiry', 'Planned quantity'));
    const editButton = button('Edit', '', () => startEditing(item));
    const deleteButton = button('Delete', 'danger', () => {
      if (saving || deleting || editing || pendingDelete) return;
      pendingDelete = item;
      discardOlderLoad();
      message(operationMessage, '');
      renderItems();
      confirmationButton.focus();
    });
    editButton.setAttribute('aria-label', 'Edit ' + item.name);
    deleteButton.setAttribute('aria-label', 'Delete ' + item.name);
    cardButtons.push(editButton, deleteButton);
    const actions = element('div', 'card-actions');
    actions.append(editButton, deleteButton);
    card.append(actions);

    if (pendingDelete && pendingDelete._id === item._id) {
      const confirmation = element('div', 'delete-confirmation');
      confirmation.append(element('p', '', 'Delete “' + item.name + '”? This permanently removes it from your shopping list.'));
      const confirm = button('Confirm delete', 'danger', async () => {
        if (saving || deleting) return;
        deleting = true;
        syncControls();
        confirm.disabled = cancel.disabled = true;
        confirm.textContent = 'Deleting…';
        message(operationMessage, 'Deleting “' + item.name + '”…');
        try {
          const response = await fetch(endpoint + '/' + encodeURIComponent(item._id), { method: 'DELETE' });
          if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Unable to delete the shopping item. Please try again.');
          }
          items = items.filter(record => record._id !== item._id);
          pendingDelete = null;
          message(formMessage, '');
          message(operationMessage, 'Deleted “' + item.name + '”.', 'success');
          renderItems();
        } catch (error) {
          message(operationMessage, error instanceof TypeError || error instanceof SyntaxError
            ? 'Unable to confirm deletion. Cancel and refresh the list before trying again.' : error.message, 'error');
        } finally {
          deleting = false;
          confirm.disabled = cancel.disabled = false;
          confirm.textContent = 'Confirm delete';
          syncControls();
          if (!pendingDelete) refreshButton.focus();
        }
      });
      const cancel = button('Cancel', '', () => {
        if (deleting) return;
        pendingDelete = null;
        message(operationMessage, 'Deletion cancelled.');
        renderItems();
        refreshButton.focus();
      });
      const actions = element('div', 'card-actions');
      actions.append(confirm, cancel);
      confirmation.append(actions);
      card.append(confirmation);
      confirmationButton = confirm;
    }
    return card;
  }

  async function loadItems() {
    const version = ++loadVersion;
    loading = true;
    list.setAttribute('aria-busy', 'true');
    listMessage.className = 'list-message';
    listMessage.textContent = 'Loading your shopping list…';
    syncControls();
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error('Unable to load shopping items.');
      const data = await response.json();
      if (!Array.isArray(data.shoppingItems)) throw new Error('The shopping list could not be read.');
      if (version !== loadVersion) return;
      items = data.shoppingItems;
      renderItems();
    } catch {
      if (version !== loadVersion) return;
      listMessage.className = 'list-message error';
      listMessage.textContent = 'Unable to load your shopping list. Check your connection, then try Refresh list.';
    } finally {
      if (version === loadVersion) {
        loading = false;
        list.setAttribute('aria-busy', 'false');
        syncControls();
      }
    }
  }

  function validateField(key) {
    const input = form.elements[key];
    let error = '';
    if (key === 'plannedQuantity') {
      if (input.value !== '' && (!Number.isFinite(Number(input.value)) || Number(input.value) <= 0)) {
        error = 'Enter a planned quantity greater than zero.';
      }
    } else if (input.value !== '' && !input.value.trim()) {
      error = key === 'name' ? 'Enter a name.' : 'Enter a unit.';
    }
    input.setCustomValidity(error);
  }

  for (const key of fields) form.elements[key].addEventListener('input', () => validateField(key));
  form.addEventListener('invalid', () => message(formMessage, 'Check the required fields. Planned quantity must be greater than zero.', 'error'), true);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving || deleting || pendingDelete) return;
    fields.forEach(validateField);
    if (!form.reportValidity()) return;
    const item = {
      name: form.elements.name.value.trim(),
      plannedQuantity: Number(form.elements.plannedQuantity.value),
      unit: form.elements.unit.value.trim()
    };
    saving = true;
    const edited = editing;
    discardOlderLoad();
    syncControls();
    form.setAttribute('aria-busy', 'true');
    saveButton.textContent = 'Saving…';
    message(operationMessage, '');
    message(formMessage, 'Saving your shopping item…');
    try {
      const response = await fetch(endpoint + (edited ? '/' + encodeURIComponent(edited._id) : ''), {
        method: edited ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save the shopping item. Please try again.');
      items = edited ? items.map(record => record._id === edited._id ? data : record) : [...items, data];
      finishEditing();
      message(formMessage, (edited ? 'Updated “' : 'Added “') + data.name + '”. Your shopping item is saved.', 'success');
      renderItems();
      await loadItems();
    } catch (error) {
      message(formMessage, error instanceof TypeError || error instanceof SyntaxError
        ? 'Unable to confirm the save. Cancel any edit and refresh the list before trying again.' : error.message, 'error');
    } finally {
      saving = false;
      syncControls();
      saveButton.textContent = editing ? 'Save changes' : '+ Add shopping item';
      form.setAttribute('aria-busy', 'false');
    }
  });

  cancelEditButton.addEventListener('click', () => {
    if (saving) return;
    finishEditing();
    message(formMessage, 'Edit cancelled.');
    form.elements.name.focus();
  });
  refreshButton.addEventListener('click', () => {
    if (!saving && !deleting && !editing && !pendingDelete) return loadItems();
  });
  loadItems();
})();
