const { ObjectId } = require('mongodb');
const { populateCategories } = require('./categories');
const { storageIdOf, locationMap } = require('./storage');
function stockOf(ingredient) {
  return Array.isArray(ingredient.batches) ? ingredient.batches : [{
    _id: ingredient._id, quantity: ingredient.quantity, unit: ingredient.unit,
    storageId: storageIdOf(ingredient), expiryDate: ingredient.expiryDate || null, ...(ingredient.packageSize ? { packageSize: ingredient.packageSize } : {})
  }];
}
function expiryKey(batch) { return batch.expiryDate ? String(batch.expiryDate instanceof Date ? batch.expiryDate.toISOString() : batch.expiryDate).slice(0,10) : '9999-99-99'; }
function compareExpiry(a,b) { return expiryKey(a).localeCompare(expiryKey(b)) || String(a.name || '').localeCompare(String(b.name || '')) || String(a._id).localeCompare(String(b._id)); }
function summarize(ingredient, locations) {
  const batches = stockOf(ingredient).map(batch => {
    const location = locations.get(String(storageIdOf(batch)));
    return { ...batch, storageId: location?._id || null, storageName: location?.name || 'Unassigned', storage: location?.legacyKey || null };
  }).sort(compareExpiry);
  const active = batches.filter(batch => batch.quantity > 0);
  const totals = [];
  for (const batch of active) {
    const total = totals.find(total => total.unit === batch.unit && (total.packageSize || null) === (batch.packageSize || null));
    if (total) total.quantity += batch.quantity;
    else totals.push({ quantity: batch.quantity, unit: batch.unit, ...(batch.packageSize ? { packageSize: batch.packageSize } : {}) });
  }
  const first = active[0];
  const primary = totals.find(total => total.unit === first?.unit && (total.packageSize || null) === (first.packageSize || null)) || { quantity: 0, unit: ingredient.unit || 'pieces' };
  const storageIds = new Set(active.map(batch => String(batch.storageId)));
  return { ...ingredient, batches, totals, quantity: primary.quantity, unit: primary.unit, packageSize: primary.packageSize || null,
    expiryDate: first?.expiryDate || null, storageId: storageIds.size === 1 ? first.storageId : null,
    storageName: storageIds.size > 1 ? 'Multiple locations' : first?.storageName || 'Unassigned',
    storage: storageIds.size === 1 ? first.storage : null };
}
async function populateInventory(items) {
  if (!items.length) return [];
  const locations = await locationMap();
  return (await populateCategories(items)).map(item => summarize(item, locations));
}
function purchasedBatch(purchase, itemId) {
  return { _id: new ObjectId(), quantity: purchase.quantity, unit: purchase.unit,
    storageId: purchase.storageId ?? null, expiryDate: purchase.expiryDate || null,
    sourceShoppingItemId: itemId, purchasedAt: new Date(), packageSize: purchase.packageSize || null };
}
module.exports = { stockOf, compareExpiry, summarize, populateInventory, purchasedBatch };
