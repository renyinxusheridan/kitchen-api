const form = document.querySelector('#ingredient-form');
const saveButton = document.querySelector('#save-button');
const formMessage = document.querySelector('#form-message');
const refreshButton = document.querySelector('#refresh-button');
const list = document.querySelector('#ingredient-list');
const listMessage = document.querySelector('#list-message');
const cards = document.querySelector('#ingredient-cards');
const count = document.querySelector('#ingredient-count');
const quantityInput = form.elements.quantity;
let saving = false;
let loadVersion = 0;

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
  return card;
}

async function loadIngredients() {
  const version = ++loadVersion;
  list.setAttribute('aria-busy', 'true');
  refreshButton.disabled = true;
  listMessage.className = 'list-message';
  listMessage.textContent = 'Loading your ingredients…';
  cards.replaceChildren();
  count.textContent = '—';
  try {
    const response = await fetch('/api/ingredients', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load your ingredients. Please try Refresh list.');
    const data = await response.json();
    if (!Array.isArray(data.ingredients)) throw new Error('The ingredient list could not be read. Please try Refresh list.');
    if (version !== loadVersion) return;
    count.textContent = data.ingredients.length;
    listMessage.textContent = data.ingredients.length ? '' : 'Your kitchen is ready for its first ingredient. Add one using the form.';
    cards.replaceChildren(...data.ingredients.map(ingredientCard));
  } catch {
    if (version !== loadVersion) return;
    listMessage.className = 'list-message error';
    listMessage.textContent = 'Unable to load your ingredients. Check your connection, then try Refresh list.';
  } finally {
    if (version === loadVersion) {
      list.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
    }
  }
}

function validateQuantity() {
  quantityInput.setCustomValidity(quantityInput.value !== '' && Number(quantityInput.value) <= 0 ? 'Enter a quantity greater than zero.' : '');
}
quantityInput.addEventListener('input', validateQuantity);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saving) return;
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
  saveButton.disabled = true;
  form.setAttribute('aria-busy', 'true');
  saveButton.textContent = 'Saving…';
  formMessage.className = 'form-message';
  formMessage.textContent = 'Saving your ingredient…';
  try {
    const response = await fetch('/api/ingredients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ingredient)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to save the ingredient. Please try again.');
    form.reset();
    quantityInput.setCustomValidity('');
    formMessage.className = 'form-message success';
    formMessage.textContent = 'Added “' + data.name + '”. Your ingredient is saved.';
    await loadIngredients();
  } catch (error) {
    formMessage.className = 'form-message error';
    formMessage.textContent = error instanceof TypeError || error instanceof SyntaxError ? 'Unable to confirm the save. Refresh the list before trying again.' : error.message;
  } finally {
    saving = false;
    saveButton.disabled = false;
    saveButton.textContent = '+ Add ingredient';
    form.setAttribute('aria-busy', 'false');
  }
});

refreshButton.addEventListener('click', loadIngredients);
loadIngredients();
