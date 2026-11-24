// Minimal DOM adapter for running the real browser script in Node tests.
// It tests UI behavior without adding a browser framework or writing to Atlas.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() { this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.disabled = false; this.ownText = ''; }
  set textContent(text) { this.ownText = String(text); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent ?? child).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.ownText = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setCustomValidity(message) { this.validationMessage = message; }
  focus() { this.focused = true; }
}

function createHarness(fetch, { categories = false, clock } = {}) {
  const nodes = Object.fromEntries(['ingredient-form', 'save-button', 'form-message', 'refresh-button', 'ingredient-list', 'list-message', 'ingredient-cards', 'ingredient-count', 'cancel-edit-button', 'add-heading', 'operation-message'].map(id => [id, new Element()]));
  const form = nodes['ingredient-form'];
  form.elements = Object.fromEntries(['name', 'quantity', 'unit', 'storage', 'expiryDate'].map(name => [name, new Element()]));
  form.elements.storage.value = 'fridge';
  if (categories) {
    nodes['category-filter'] = new Element();
    form.elements.categoryId = new Element();
    form.elements.categoryId.value = '';
  }
  form.reportValidity = () => !Object.values(form.elements).some(field => field.validationMessage);
  form.reset = () => {
    for (const field of Object.values(form.elements)) field.value = '';
    form.elements.storage.value = 'fridge';
    if (categories) form.elements.categoryId.value = '';
    form.resetCount = (form.resetCount || 0) + 1;
  };
  const events = {};
  const document = { querySelector: selector => nodes[selector.slice(1)], createElement: () => new Element(), addEventListener(name,fn) { events[name]=fn; } };
  const extra = {};
  if (clock) {
    class LocalDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return +clock.now; } }
    Object.assign(extra,{Date:LocalDate,window:{addEventListener(name,fn){events[name]=fn;}},setTimeout(fn,delay){clock.timer=fn;clock.delay=delay;return 1;},clearTimeout(){}});
  }
  const context = vm.createContext({ document, fetch, ...extra, ...(categories ? { categoryUI: { set(select, value) { select.value = value || ''; }, available: () => true } } : {}) });
  if (clock) vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/expiry.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);

  return { nodes, form, events, submit: () => form.listeners.submit({ preventDefault() {} }) };
}

module.exports = { createHarness, flush: () => new Promise(resolve => setImmediate(resolve)) };
