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
}

function createHarness(fetch) {
  const nodes = Object.fromEntries(['ingredient-form', 'save-button', 'form-message', 'refresh-button', 'ingredient-list', 'list-message', 'ingredient-cards', 'ingredient-count'].map(id => [id, new Element()]));
  const form = nodes['ingredient-form'];
  form.elements = Object.fromEntries(['name', 'quantity', 'unit', 'storage', 'expiryDate'].map(name => [name, new Element()]));
  form.elements.storage.value = 'fridge';
  form.reportValidity = () => !Object.values(form.elements).some(field => field.validationMessage);
  form.reset = () => {
    for (const field of Object.values(form.elements)) field.value = '';
    form.elements.storage.value = 'fridge';
    form.resetCount = (form.resetCount || 0) + 1;
  };
  const document = { querySelector: selector => nodes[selector.slice(1)], createElement: () => new Element() };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), { document, fetch });
  return { nodes, form, submit: () => form.listeners.submit({ preventDefault() {} }) };
}

module.exports = { createHarness, flush: () => new Promise(resolve => setImmediate(resolve)) };
