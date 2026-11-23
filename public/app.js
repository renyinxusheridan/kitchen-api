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
const kitchenUI = globalThis.kitchenUI;
const categoryFilter = document.querySelector('#category-filter');
let adding = false;
let saving = false;
let deleting = false;
let loading = false;
let editing = null;
let pendingDelete = null;
let inventory = [];
let cardButtons = [];
let confirmationButton;
let loadVersion = 0;
let shoppingAction = null;

function syncControls() {
  const busy = saving || deleting || shoppingAction !== null;
  const active = busy || editing !== null || pendingDelete !== null || adding;
  refreshButton.disabled = loading || active;
  saveButton.disabled = busy || pendingDelete !== null;
  cancelEditButton.disabled = busy;
  if (categoryFilter) categoryFilter.disabled = active;
  if (form.elements.category) form.elements.category.disabled = busy;
  for (const key of ['name', 'quantity', 'unit', 'storage', 'expiryDate']) form.elements[key].disabled = busy;
  for (const button of cardButtons) button.disabled = active;
}

function message(node, text, state = '') {
  node.className = 'form-message' + (state ? ' ' + state : '');
  node.textContent = text;
}

function finishEditing() {
  adding = false;
  editing = null;
  form.reset();
  quantityInput.setCustomValidity('');
  formHeading.textContent = 'Add an ingredient';
  saveButton.textContent = '+ Add ingredient';
  cancelEditButton.hidden = true;
  syncControls();
}

function startEditing(ingredient) {
  if (saving || deleting || editing || pendingDelete || shoppingAction || adding) return;
  editing = ingredient;
  // Discard an older GET so it cannot replace cards while the form is open.
  ++loadVersion;
  loading = false;
  list.setAttribute('aria-busy', 'false');
  formHeading.textContent = 'Edit an ingredient';
  for (const key of ['name', 'quantity', 'unit', 'storage']) form.elements[key].value = ingredient[key];
  if (form.elements.category) form.elements.category.value = ingredient.category || 'other';
  globalThis.kitchenUnits?.set(form.elements.unit, ingredient.unit);
  form.elements.expiryDate.value = ingredient.expiryDate ? ingredient.expiryDate.slice(0, 10) : '';
  quantityInput.setCustomValidity('');
  saveButton.textContent = 'Save changes';
  cancelEditButton.hidden = false;
  message(formMessage, kitchenUI ? '' : 'Editing “' + ingredient.name + '”.');
  message(operationMessage, '');
  renderInventory();
  kitchenUI?.open('ingredient-dialog', { onCancel: cancelIngredient, busy: () => saving, fallback: '#add-ingredient' });
  form.elements.name.focus();
}

function renderInventory() {
  cardButtons = [];
  cards.replaceChildren(...inventory.map(ingredientCard));
  count.textContent = inventory.length;
  listMessage.textContent = inventory.length ? '' : categoryFilter?.value ? 'No ingredients match this category.' : 'Add your first ingredient.';
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
  expiry.append(element('span', '', kitchenUI ? 'Use by' : 'Expiry date'));
  if (ingredient.expiryDate && !Number.isNaN(Date.parse(ingredient.expiryDate))) {
    const time = element('time', '', new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(ingredient.expiryDate)));
    time.dateTime = ingredient.expiryDate.slice(0, 10);
    expiry.append(time);
  } else {
    expiry.append(element('span', '', 'Not set'));
  }
  card.append(header, amount);
  if (ingredient.expiryDate || !kitchenUI) card.append(expiry);
  const actions = element('div', 'card-actions');
  const editButton = element('button', 'button secondary', 'Edit');
  const deleteButton = element('button', 'button secondary danger', 'Delete');
  const shoppingButton = element('button', 'button secondary', kitchenUI ? 'Add to list' : 'Add to shopping list');
  for (const button of [editButton, deleteButton, shoppingButton]) {
    button.type = 'button';
    cardButtons.push(button);
  }
  editButton.setAttribute('aria-label', 'Edit ' + ingredient.name);
  deleteButton.setAttribute('aria-label', 'Delete ' + ingredient.name);
  shoppingButton.setAttribute('aria-label', 'Add ' + ingredient.name + ' to shopping list');
  shoppingButton.addEventListener('click', () => openShopping(ingredient));
  editButton.addEventListener('click', () => startEditing(ingredient));
  deleteButton.addEventListener('click', () => {
    if (saving || deleting || editing || pendingDelete || shoppingAction || adding) return;
    pendingDelete = ingredient;
    ++loadVersion;
    loading = false;
    list.setAttribute('aria-busy', 'false');
    message(operationMessage, '');
    renderInventory();
    kitchenUI?.open('ingredient-delete-dialog', { onCancel: cancelIngredientDelete, busy: () => deleting, fallback: '#add-ingredient' });
    confirmationButton.focus();
  });
  if (kitchenUI) {
    const menu = kitchenUI.cardActions(ingredient.name, shoppingButton, editButton, deleteButton);
    cardButtons.push(menu.toggle);
    card.append(menu.root);
  } else {
    actions.append(editButton, deleteButton, shoppingButton);
    card.append(actions);
  }
  if (shoppingAction?.ingredient._id === ingredient._id) {
    const plan = shoppingPlan();
    if (kitchenUI) kitchenUI.content('plan-content', plan);
    else card.append(plan);
  }
  if (pendingDelete && pendingDelete._id === ingredient._id) {
    const confirmation = element('div', 'delete-confirmation');
    confirmation.append(element('p', '', 'Delete “' + ingredient.name + '”? This permanently removes it from your inventory.'));
    const confirm = element('button', 'button secondary danger', 'Confirm delete');
    const cancel = element('button', 'button secondary', 'Cancel');
    confirm.type = cancel.type = 'button';
    confirm.addEventListener('click', async () => {
      if (saving || deleting) return;
      deleting = true;
      kitchenUI?.busy(true);
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
        kitchenUI?.dismiss('ingredient-delete-dialog');
        kitchenUI?.toast('Deleted “' + ingredient.name + '”.');
        if (kitchenUI) await kitchenUI.refreshAll();
      } catch (error) {
        message(operationMessage, error instanceof TypeError || error instanceof SyntaxError ? 'Unable to confirm deletion. Cancel and refresh the list before trying again.' : error.message, 'error');
      } finally {
        deleting = false;
        kitchenUI?.busy(false);
        confirm.disabled = cancel.disabled = false;
        confirm.textContent = 'Confirm delete';
        syncControls();
        if (!pendingDelete) refreshButton.focus();
      }
    });
    cancel.addEventListener('click', cancelIngredientDelete);
    const buttons = element('div', 'card-actions');
    buttons.append(confirm, cancel);
    confirmation.append(buttons);
    if (kitchenUI) kitchenUI.content('ingredient-delete-content', confirmation);
    else card.append(confirmation);
    confirmationButton = confirm;
  }
  return card;
}

async function openShopping(ingredient) {
  if (saving || deleting || editing || pendingDelete || shoppingAction || adding) return;
  const action = { ingredient, checking: true, matches: [], selected: null, plannedQuantity: 1, unit: globalThis.kitchenUnits?.preferred() || ingredient.unit };
  shoppingAction = action;
  ++loadVersion;
  loading = false;
  list.setAttribute('aria-busy', 'false');
  message(operationMessage, '');
  renderInventory();
  kitchenUI?.open('plan-dialog', { onCancel: cancelShoppingPlan, busy: () => action.saving || action.checking, fallback: '#add-ingredient' });
  try {
    const response = await fetch('/api/shopping-items?ingredientId=' + encodeURIComponent(ingredient._id), { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.shoppingItems)) throw new Error(data.error || 'Unable to check the shopping list.');
    action.matches = data.shoppingItems;
  } catch {
    action.error = 'Unable to check your shopping list. Cancel and try again when connected.';
  }
  action.checking = false;
  renderInventory();
  (document.querySelector('#shopping-plan-quantity') || document.querySelector('.card-form button'))?.focus();
}

function shoppingPlan() {
  const action = shoppingAction;
  const panel = element('div', 'card-form');
  panel.append(element('p', 'item-name', action.ingredient.name));
  const cancel = element('button', 'button secondary cancel-edit', 'Cancel');
  cancel.type = 'button';
  cancel.disabled = action.checking;
  cancel.addEventListener('click', cancelShoppingPlan);
  if (action.checking || action.error) {
    panel.append(element('p', action.error ? 'form-message error' : 'form-message', action.error || 'Checking your shopping list…'), cancel);
    return panel;
  }
  if (action.matches.length && !action.selected) {
    panel.append(element('p', 'form-hint', 'Already on your shopping list. Edit an existing item instead of adding a duplicate.'));
    for (const item of action.matches) {
      panel.append(element('p', 'form-hint', item.name + ' · Planned: ' + item.plannedQuantity + ' ' + item.unit));
      const edit = element('button', 'button secondary', 'Edit shopping item');
      edit.type = 'button';
      edit.addEventListener('click', () => {
        action.selected = item;
        action.plannedQuantity = item.plannedQuantity;
        action.unit = item.unit;
        renderInventory();
        document.querySelector('#shopping-plan-quantity')?.focus();
      });
      panel.append(edit);
    }
    panel.append(cancel);
    return panel;
  }

  if (action.selected) panel.append(element('h4', '', 'Edit shopping item'));
  const plan = element('form');
  const row = element('div', 'field-row');
  const quantity = element('input');
  quantity.id = 'shopping-plan-quantity';
  quantity.type = 'number';
  quantity.min = '0';
  quantity.step = 'any';
  quantity.required = true;
  quantity.value = action.plannedQuantity;
  const unit = element(globalThis.kitchenUnits ? 'select' : 'input');
  unit.id = 'shopping-plan-unit';
  unit.type = 'text';
  unit.maxLength = 40;
  unit.required = true;
  unit.value = action.unit;
  for (const [input, title] of [[quantity, 'Planned quantity'], [unit, 'Unit']]) {
    const field = element('div', 'field');
    const label = element('label', '', title);
    label.htmlFor = input.id;
    input.addEventListener('input', () => input.setCustomValidity(''));
    field.append(label, input);
    row.append(field);
    if (input === unit) globalThis.kitchenUnits?.bind(unit, action.unit);
  }
  const submit = element('button', 'button primary', action.selected ? 'Save shopping changes' : 'Add to shopping list');
  submit.type = 'submit';
  const feedback = element('p', 'form-message');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  plan.append(row, submit, cancel, feedback);
  plan.addEventListener('submit', async event => {
    event.preventDefault();
    if (action.saving) return;
    quantity.setCustomValidity(Number.isFinite(Number(quantity.value)) && Number(quantity.value) > 0 ? '' : 'Enter a planned quantity greater than zero.');
    unit.setCustomValidity((globalThis.kitchenUnits?.value(unit) ?? unit.value).trim() ? '' : 'Enter a unit.');
    if (!plan.reportValidity()) return;
    action.plannedQuantity = Number(quantity.value);
    action.unit = (globalThis.kitchenUnits?.value(unit) ?? unit.value).trim();
    action.saving = true;
    kitchenUI?.busy(true);
    quantity.disabled = unit.disabled = submit.disabled = cancel.disabled = true;
    plan.setAttribute('aria-busy', 'true');
    message(feedback, 'Saving your shopping item…');
    const selected = action.selected;
    const body = { name: selected?.name || action.ingredient.name, plannedQuantity: action.plannedQuantity, unit: action.unit };
    if (!selected?.ingredientId) body.ingredientId = action.ingredient._id;
    try {
      const response = await fetch('/api/shopping-items' + (selected ? '/' + encodeURIComponent(selected._id) : ''), {
        method: selected ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.existingItem) {
          action.matches = [data.existingItem];
          action.selected = null;
          renderInventory();
          return;
        }
        throw new Error(data.error || 'Unable to save the shopping item.');
      }
      globalThis.kitchenUnits?.remember(body.unit);
      shoppingAction = null;
      renderInventory();
      message(operationMessage, (selected ? 'Updated “' : 'Added “') + data.name + '” on your shopping list.', 'success');
      kitchenUI?.dismiss('plan-dialog');
      kitchenUI?.toast((selected ? 'Updated “' : 'Added “') + data.name + '” on your list.');
      if (kitchenUI) await kitchenUI.refreshAll();
      else refreshButton.focus();
    } catch (error) {
      message(feedback, error instanceof TypeError || error instanceof SyntaxError
        ? 'Unable to confirm the save. Cancel and open Add to shopping list again to check the saved item.' : error.message, 'error');
    } finally {
      action.saving = false;
      kitchenUI?.busy(false);
      quantity.disabled = unit.disabled = submit.disabled = cancel.disabled = false;
      plan.setAttribute('aria-busy', 'false');
    }
  });
  panel.append(plan);
  return panel;
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
    const query = categoryFilter?.value ? '?category=' + encodeURIComponent(categoryFilter.value) : '';
    const response = await fetch('/api/ingredients' + query, { cache: 'no-store' });
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
  if (saving || deleting || pendingDelete || shoppingAction) return;
  validateQuantity();
  if (!form.reportValidity()) return;
  const ingredient = {
    name: form.elements.name.value.trim(),
    quantity: Number(quantityInput.value),
    unit: (globalThis.kitchenUnits?.value(form.elements.unit) ?? form.elements.unit.value).trim(),
    storage: form.elements.storage.value,
    expiryDate: form.elements.expiryDate.value || null
  };
  if (form.elements.category) ingredient.category = form.elements.category.value;
  saving = true;
  kitchenUI?.busy(true);
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
    globalThis.kitchenUnits?.remember(ingredient.unit);
    finishEditing();
    formMessage.className = 'form-message success';
    formMessage.textContent = (edited ? 'Updated “' : 'Added “') + data.name + '”. Your ingredient is saved.';
    if (edited) {
      inventory = inventory.map(record => record._id === edited._id ? data : record);
      renderInventory();
    }
    kitchenUI?.dismiss('ingredient-dialog');
    kitchenUI?.toast('Saved “' + data.name + '”.');
    await (kitchenUI ? kitchenUI.refreshAll() : loadIngredients());
  } catch (error) {
    formMessage.className = 'form-message error';
    formMessage.textContent = error instanceof TypeError || error instanceof SyntaxError ? 'Unable to confirm the save. Refresh the list before trying again.' : error.message;
  } finally {
    saving = false;
    kitchenUI?.busy(false);
    syncControls();
    saveButton.textContent = editing ? 'Save changes' : '+ Add ingredient';
    form.setAttribute('aria-busy', 'false');
  }
});

function cancelIngredient() {
  if (saving) return;
  finishEditing();
  message(formMessage, 'Edit cancelled.');
  if (kitchenUI) kitchenUI.dismiss('ingredient-dialog');
  else form.elements.name.focus();
}
function cancelIngredientDelete() {
  if (deleting) return;
  pendingDelete = null;
  message(operationMessage, 'Deletion cancelled.');
  renderInventory();
  kitchenUI?.dismiss('ingredient-delete-dialog');
  if (!kitchenUI) refreshButton.focus();
}
function cancelShoppingPlan() {
  if (shoppingAction?.saving || shoppingAction?.checking) return;
  shoppingAction = null;
  renderInventory();
  kitchenUI?.dismiss('plan-dialog');
  if (!kitchenUI) refreshButton.focus();
}
cancelEditButton.addEventListener('click', cancelIngredient);
refreshButton.addEventListener('click', () => {
  if (!saving && !deleting && !editing && !pendingDelete && !shoppingAction && !adding) return kitchenUI ? kitchenUI.refreshAll() : loadIngredients();
});
kitchenUI?.register('inventory', loadIngredients);
document.querySelector('#add-ingredient')?.addEventListener('click', () => {
  if (saving || deleting || editing || pendingDelete || shoppingAction || adding) return;
  finishEditing();
  adding = true;
  globalThis.kitchenUnits?.set(form.elements.unit, globalThis.kitchenUnits.preferred());
  cancelEditButton.hidden = false;
  message(formMessage, '');
  kitchenUI.open('ingredient-dialog', { onCancel: cancelIngredient, busy: () => saving, fallback: '#add-ingredient' });
  syncControls();
  form.elements.name.focus();
});
loadIngredients();
categoryFilter?.addEventListener('change', loadIngredients);
