(() => {
  const presets = ['pieces', 'bags', 'packs', 'bottles', 'cartons', 'bunches', 'g', 'kg', 'mL', 'L'];
  const key = 'kitchen.unitPreferences.v1';
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch { saved = {}; }
  const valid = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 40 && value !== '__custom__';
  let custom = [...new Set((Array.isArray(saved?.custom) ? saved.custom : []).filter(valid).map(value => value.trim()))].filter(value => !presets.includes(value));
  let defaultUnit = valid(saved?.defaultUnit) ? saved.defaultUnit.trim() : '';
  let last = valid(saved?.last) ? saved.last.trim() : 'pieces';
  function persist() {
    try { localStorage.setItem(key, JSON.stringify({ custom, defaultUnit, last })); }
    catch { document.querySelector('#settings-message').textContent = 'Browser storage is unavailable. Settings will last for this session.'; }
  }
  function options(select, value, includeCustom = true) {
    select.replaceChildren();
    for (const unit of new Set([...presets, ...custom, ...(value && value !== '__custom__' ? [value] : [])])) {
      const option = document.createElement('option'); option.value = option.textContent = unit; select.append(option);
    }
    if (includeCustom) { const option = document.createElement('option'); option.value = '__custom__'; option.textContent = 'Custom unit…'; select.append(option); }
    select.value = value;
  }
  function preferred() { return defaultUnit || last || 'pieces'; }
  function set(select, value) { options(select, value); select.dispatchEvent(new Event('change')); }
  function value(select) { return select.value === '__custom__' ? select._customInput.value.trim() : select.value; }
  function bind(select, initial = preferred()) {
    const field = document.createElement('div'); field.className = 'custom-unit-field'; field.hidden = true;
    const label = document.createElement('label'); label.htmlFor = select.id + '-custom'; label.textContent = 'Custom unit';
    const input = document.createElement('input'); input.id = label.htmlFor; input.maxLength = 40; input.type = 'text'; input.required = true; input.disabled = true; input.autocomplete = 'off';
    field.append(label, input); select.after(field); select._customInput = input;
    function sync() {
      const active = select.value === '__custom__'; field.hidden = !active; input.disabled = !active || select.disabled;
      select.setCustomValidity('');
    }
    select.addEventListener('change', () => { sync(); if (!field.hidden) input.focus(); });
    input.addEventListener('input', () => { input.setCustomValidity(input.value.trim() ? '' : 'Enter a custom unit.'); select.setCustomValidity(''); select.dispatchEvent(new Event('input')); });
    input.addEventListener('change', () => { const unit = input.value.trim(); if (valid(unit) && !presets.includes(unit) && !custom.includes(unit)) { custom.push(unit); persist(); } });
    new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ['disabled'] });
    options(select, initial); sync();
  }
  function remember(unit) {
    if (!valid(unit)) return;
    last = unit.trim(); if (!presets.includes(last) && !custom.includes(last)) custom.push(last);
    persist();
  }
  for (const select of document.querySelectorAll('[data-unit]')) bind(select);
  const defaultSelect = document.querySelector('#default-unit');
  const customList = document.querySelector('#custom-unit-list');
  function settings() {
    options(defaultSelect, defaultUnit, false);
    const automatic = document.createElement('option'); automatic.value = ''; automatic.textContent = 'Last used (or pieces)'; defaultSelect.prepend(automatic); defaultSelect.value = defaultUnit;
    customList.replaceChildren();
    for (const unit of custom) {
      const row = document.createElement('li'); const name = document.createElement('span'); name.textContent = unit;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button secondary'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove custom unit ' + unit);
      remove.addEventListener('click', () => { custom = custom.filter(item => item !== unit); if(defaultUnit === unit) defaultUnit = ''; if(last === unit) last = 'pieces'; persist(); settings(); defaultSelect.focus(); });
      row.append(name, remove); customList.append(row);
    }
  }
  defaultSelect.addEventListener('change', () => { defaultUnit = defaultSelect.value; persist(); });
  document.querySelector('#custom-unit-form').addEventListener('submit', event => {
    event.preventDefault(); const input = document.querySelector('#new-custom-unit'); const unit = input.value.trim();
    input.setCustomValidity(!valid(unit) ? 'Enter a custom unit with 1–40 characters.' : [...presets, ...custom].includes(unit) ? 'That unit is already available.' : '');
    if (!input.reportValidity()) return;
    custom.push(unit); persist(); settings(); input.value = ''; input.focus();
  });
  document.querySelector('#new-custom-unit').addEventListener('input', event => event.target.setCustomValidity(''));
  document.querySelector('#settings-button').addEventListener('click', () => { settings(); globalThis.kitchenUI.open('settings-dialog', { onCancel: () => globalThis.kitchenUI.dismiss('settings-dialog'), fallback: '#settings-button' }); });
  globalThis.kitchenUnits = { bind, set, value, preferred, remember };
})();
