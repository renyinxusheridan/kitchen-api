globalThis.createReferenceManager({
  global: 'categoryUI', section: 'categories-settings', message: 'categories-message', list: 'categories-list',
  form: 'category-management-form', input: 'category-name', createMessage: 'category-create-message', retry: 'categories-retry',
  singular: 'Category', title: 'Categories', collection: 'categories', endpoint: '/api/categories', fallback: 'Uncategorized',
  selectors: '[data-category],[data-category-filter]', filterAttribute: 'data-category-filter', allLabel: 'All categories',
  deletionText: detail => 'Delete “'+detail.name+'”? '+detail.inventoryCount+' inventory record(s) and '+detail.shoppingCount+' shopping item(s) will become Uncategorized. No items will be deleted.'
});
