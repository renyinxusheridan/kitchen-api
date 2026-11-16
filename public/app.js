const form = document.querySelector('#ingredient-form');
const saveButton = document.querySelector('#save-button');
const formMessage = document.querySelector('#form-message');
const refreshButton = document.querySelector('#refresh-button');
const list = document.querySelector('#ingredient-list');
const listMessage = document.querySelector('#list-message');
const cards = document.querySelector('#ingredient-cards');
const count = document.querySelector('#ingredient-count');
const quantityInput = form.elements.quantity;
const cancelEditButton = document.querySelector('#cancel-edit-button');
const formHeading = document.querySelector('#add-heading');
const operationMessage = document.querySelector('#operation-message');
let saving = false;
let deleting = false;
let loading = false;
let editing = null;
let pendingDelete = null;
let inventory = [];
let cardButtons = [];
let confirmationButton;
let loadVersion = 0;

function syncControls() {
  const busy = saving || deleting;
  const active = busy || editing !== null || pendingDelete !== null;
  refreshButton.disabled = loading || active;
  saveButton.disabled = busy || pendingDelete !== null;
  cancelEditButton.disabled = busy;
  for (const key of ['name', 'quantity', 'unit', 'storage', 'expiryDate']) form.elements[key].disabled = busy;
  for (const button of cardButtons) button.disabled = active;
}

function message(node, text, state = '') {
  node.className = 'form-message' + (state ? ' ' + state : '');
  node.textContent = text;
}

function finishEditing() {
  editing = null;
  form.reset();
  quantityInput.setCustomValidity('');
  formHeading.textContent = 'Add an ingredient';
  saveButton.textContent = '+ Add ingredient';
  cancelEditButton.hidden = true;
  syncControls();
}

function startEditing(ingredient) {
  if (saving || deleting || editing || pendingDelete) return;
  editing = ingredient;
  // Discard an older GET so it cannot replace cards while the form is open.
  ++loadVersion;
  loading = false;
  list.setAttribute('aria-busy', 'false');
  formHeading.textContent = 'Edit an ingredient';
  for (const key of ['name', 'quantity', 'unit', 'storage']) form.elements[key].value = ingredient[key];
  form.elements.expiryDate.value = ingredient.expiryDate ? ingredient.expiryDate.slice(0, 10) : '';
  quantityInput.setCustomValidity('');
  saveButton.textContent = 'Save changes';
  cancelEditButton.hidden = false;
  message(formMessage, 'Editing “' + ingredient.name + '”.');
  message(operationMessage, '');
  renderInventory();
  form.elements.name.focus();
}

function renderInventory() {
  cardButtons = [];
  cards.replaceChildren(...inventory.map(ingredientCard));
  count.textContent = inventory.length;
  listMessage.textContent = inventory.length ? '' : 'Your kitchen is ready for its first ingredient. Add one using the form.';
  listMessage.className = 'list-message';
  syncControls();
}

// DOM textContent keeps ingredient names and other user text from becoming HTML.
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ingredientCard(ingredient) {
  const card = element('li', 'ingredient-card');
  const header = element('div', 'card-header');
  header.append(element('h3', '', ingredient.name));
  const locations = { fridge: 'Fridge', freezer: 'Freezer', pantry: 'Pantry' };
  const storage = Object.hasOwn(locations, ingredient.storage) ? ingredient.storage : 'pantry';
  header.append(element('span', 'storage storage-' + storage, locations[ingredient.storage] || ingredient.storage));
  const amount = element('p', 'amount', String(ingredient.quantity));
  amount.append(element('span', '', ingredient.unit));
  const expiry = element('p', 'expiry');
  expiry.append(element('span', '', 'Expiry date'));
  if (ingredient.expiryDate && !Number.isNaN(Date.parse(ingredient.expiryDate))) {
    const time = element('time', '', new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(ingredient.expiryDate)));
    time.dateTime = ingredient.expiryDate.slice(0, 10);
    expiry.append(time);
  } else {
    expiry.append(element('span', '', 'Not set'));
  }
  card.append(header, amount, expiry);
  const actions = element('div', 'card-actions');
  const editButton = element('button', 'button secondary', 'Edit');
  const deleteButton = element('button', 'button secondary danger', 'Delete');
  for (const button of [editButton, deleteButton]) {
    button.type = 'button';
    cardButtons.push(button);
  }
  editButton.setAttribute('aria-label', 'Edit ' + ingredient.name);
  deleteButton.setAttribute('aria-label', 'Delete ' + ingredient.name);
  editButton.addEventListener('click', () => startEditing(ingredient));
  deleteButton.addEventListener('click', () => {
    if (saving || deleting || editing || pendingDelete) return;
    pendingDelete = ingredient;
    ++loadVersion;
    loading = false;
    list.setAttribute('aria-busy', 'false');
    message(operationMessage, '');
    renderInventory();
    confirmationButton.focus();
  });
  actions.append(editButton, deleteButton);
  card.append(actions);
  if (pendingDelete && pendingDelete._id === ingredient._id) {
    const confirmation = element('div', 'delete-confirmation');
    confirmation.append(element('p', '', 'Delete “' + ingredient.name + '”? This permanently removes it from your inventory.'));
    const confirm = element('button', 'button secondary danger', 'Confirm delete');
    const cancel = element('button', 'button secondary', 'Cancel');
    confirm.type = cancel.type = 'button';
    confirm.addEventListener('click', async () => {
      if (saving || deleting) return;
      deleting = true;
      syncControls();
      confirm.disabled = cancel.disabled = true;
      confirm.textContent = 'Deleting…';
      message(operationMessage, 'Deleting “' + ingredient.name + '”…');
      try {
        const response = await fetch('/api/ingredients/' + encodeURIComponent(ingredient._id), { method: 'DELETE' });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Unable to delete the ingredient. Please try again.');
        }
        inventory = inventory.filter(record => record._id !== ingredient._id);
        pendingDelete = null;
        message(operationMessage, 'Deleted “' + ingredient.name + '”.', 'success');
        renderInventory();
      } catch (error) {
        message(operationMessage, error instanceof TypeError || error instanceof SyntaxError ? 'Unable to confirm deletion. Cancel and refresh the list before trying again.' : error.message, 'error');
      } finally {
        deleting = false;
        confirm.disabled = cancel.disabled = false;
        confirm.textContent = 'Confirm delete';
        syncControls();
        if (!pendingDelete) refreshButton.focus();
      }
    });
    cancel.addEventListener('click', () => {
      if (deleting) return;
      pendingDelete = null;
      message(operationMessage, 'Deletion cancelled.');
      renderInventory();
      refreshButton.focus();
    });
    const buttons = element('div', 'card-actions');
    buttons.append(confirm, cancel);
    confirmation.append(buttons);
    card.append(confirmation);
    confirmationButton = confirm;
  }
  return card;
}

async function loadIngredients() {
  const version = ++loadVersion;
  loading = true;
  list.setAttribute('aria-busy', 'true');
  refreshButton.disabled = true;
  listMessage.className = 'list-message';
  listMessage.textContent = 'Loading your ingredients…';
  syncControls();
  try {
    const response = await fetch('/api/ingredients', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load your ingredients. Please try Refresh list.');
    const data = await response.json();
    if (!Array.isArray(data.ingredients)) throw new Error('The ingredient list could not be read. Please try Refresh list.');
    if (version !== loadVersion) return;
    inventory = data.ingredients;
    renderInventory();
  } catch {
    if (version !== loadVersion) return;
    listMessage.className = 'list-message error';
    listMessage.textContent = 'Unable to load your ingredients. Check your connection, then try Refresh list.';
  } finally {
    if (version === loadVersion) {
      list.setAttribute('aria-busy', 'false');
      loading = false;
      syncControls();
    }
  }
}

function validateQuantity() {
  quantityInput.setCustomValidity(quantityInput.value !== '' && Number(quantityInput.value) <= 0 ? 'Enter a quantity greater than zero.' : '');
}
quantityInput.addEventListener('input', validateQuantity);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saving || deleting || pendingDelete) return;
  validateQuantity();
  if (!form.reportValidity()) return;
  const ingredient = {
    name: form.elements.name.value.trim(),
    quantity: Number(quantityInput.value),
    unit: form.elements.unit.value.trim(),
    storage: form.elements.storage.value,
    expiryDate: form.elements.expiryDate.value || null
  };
  saving = true;
  const edited = editing;
  syncControls();
  form.setAttribute('aria-busy', 'true');
  saveButton.textContent = 'Saving…';
  formMessage.className = 'form-message';
  formMessage.textContent = 'Saving your ingredient…';
  try {
    const response = await fetch('/api/ingredients' + (edited ? '/' + encodeURIComponent(edited._id) : ''), {
      method: edited ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ingredient)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to save the ingredient. Please try again.');
    finishEditing();
    formMessage.className = 'form-message success';
    formMessage.textContent = (edited ? 'Updated “' : 'Added “') + data.name + '”. Your ingredient is saved.';
    if (edited) {
      inventory = inventory.map(record => record._id === edited._id ? data : record);
      renderInventory();
    }
    await loadIngredients();
  } catch (error) {
    formMessage.className = 'form-message error';
    formMessage.textContent = error instanceof TypeError || error instanceof SyntaxError ? 'Unable to confirm the save. Refresh the list before trying again.' : error.message;
  } finally {
    saving = false;
    syncControls();
    saveButton.textContent = editing ? 'Save changes' : '+ Add ingredient';
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
  if (!saving && !deleting && !editing && !pendingDelete) return loadIngredients();
});
loadIngredients();
