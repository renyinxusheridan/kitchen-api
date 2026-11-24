(() => {
  let last = '';
  try { last = localStorage.getItem('kitchen.lastStorage.v1') || ''; } catch {}
  const api = globalThis.createReferenceManager({
    global: 'storageUI', section: 'locations-settings', message: 'locations-message', list: 'locations-list',
    form: 'location-management-form', input: 'location-name', createMessage: 'location-create-message', retry: 'locations-retry',
    singular: 'Location', title: 'Storage locations', collection: 'locations', endpoint: '/api/storage-locations', fallback: 'Unassigned',
    selectors: '[data-storage]',
    deletionText: detail => 'Delete “'+detail.name+'”? '+detail.batchCount+' stock batch(es) in '+detail.inventoryCount+' ingredient(s) and '+detail.shoppingCount+' shopping item(s) will become Unassigned. No food will be deleted.'
  });
  api.preferred = () => api.values().some(location => location._id === last) ? last : '';
  api.remember = id => { last = id || ''; try { localStorage.setItem('kitchen.lastStorage.v1',last); } catch {} };
})();
