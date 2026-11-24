const { ObjectId } = require('mongodb');
const { getDatabase, withTransaction, connectionErrorMessage } = require('./db');
const { fail, categoryIdOf, touchCategory, populateCategories } = require('./categories');
const { storageIdOf, touchStorage, validId } = require('./storage');
const { stockOf, populateInventory, purchasedBatch } = require('./stock');
const { resolveMatch, rememberAlias } = require('./matching');
const { validateIngredient } = require('./ingredient-validation');
async function reviewPurchases() {
  const database = await getDatabase();
  const items = await database.collection('shopping_items').find({ pickedUp: true, status: { $ne: 'completed' } }).sort({ name: 1, _id: 1 }).toArray();
  const inventory = await populateInventory(await database.collection('ingredients').find({}).toArray());
  const aliases = await database.collection('ingredient_aliases').find({}).toArray();
  return { items: (await populateCategories(items)).map(item => ({ ...item, storageId: storageIdOf(item), match: resolveMatch(item,inventory,aliases) })), inventory, count: items.length };
}
function validateRow(row) {
  if (!row || !validId(row.shoppingItemId)) throw fail(400,'Choose a valid shopping item.');
  if (!['auto','selected','separate'].includes(row.matchMode)) throw fail(400,'Choose a suggested ingredient or Keep separate.');
  if (row.matchMode === 'selected' && !validId(row.matchId)) throw fail(400,'Choose an existing ingredient.');
  if (row.rememberAlias !== undefined && typeof row.rememberAlias !== 'boolean') throw fail(400,'Confirm whether to remember this name.');
  const req = { body: { ...row, name: 'Purchase' } };
  let problem;
  validateIngredient(req,{ status(status) { this.code=status;return this; },json(body) { problem=fail(this.code,body.error); } },()=>{});
  if (problem) throw problem;
  return { ...row, ...req.ingredient };
}
async function transferOne(raw, { requirePicked = true } = {}) {
  const row = validateRow(raw);
  return withTransaction(async(database,session) => {
    const shopping = database.collection('shopping_items');
    const inventory = database.collection('ingredients');
    // Receipts outlive the shopping row and even later stock edits/deletions.
    // Their unique _id is the original shopping ID, so a lost response is safe
    // to retry after the item has disappeared from the list.
    const receipts = database.collection('purchase_receipts');
    const shoppingId = new ObjectId(row.shoppingItemId);
    const previous = await receipts.findOne({ _id: shoppingId },{ session });
    if (previous) return { shoppingItemId: row.shoppingItemId, alreadyCompleted: true, removed: true, ingredientId: previous.ingredientId, batchId: previous.batchId };
    const item = await shopping.findOne({ _id: shoppingId },{ session });
    if (!item) throw fail(404,'Shopping item no longer exists.');
    await database.collection('_workflow_locks').updateOne({ _id: 'inventory-matching' },{ $inc: { revision: 1 } },{ session, upsert: true });
    if (item.status === 'completed') {
      await receipts.insertOne({ _id: item._id, shoppingItem: item, ingredientId: item.purchase?.ingredientId || item.ingredientId, batchId: item.purchase?.batchId, completedAt: item.completedAt || new Date() },{ session });
      const removed = await shopping.deleteOne({ _id: item._id, status: 'completed' },{ session });
      if (!removed.deletedCount) throw fail(409,'This shopping item changed. Refresh the review before retrying.');
      return { shoppingItemId: row.shoppingItemId, alreadyCompleted: true, removed: true, ingredientId: item.purchase?.ingredientId || item.ingredientId, batchId: item.purchase?.batchId };
    }
    if (raw.unit === item.unit) row.unit = item.unit; // Preserve an unchanged legacy unit verbatim.
    if (requirePicked && item.pickedUp !== true) throw fail(409,'This item is no longer picked up. Refresh your review.');
    const all = await inventory.find({}, { session }).toArray();
    const aliases = await database.collection('ingredient_aliases').find({}, { session }).toArray();
    const match = resolveMatch(item,all,aliases);
    let ingredient;
    if (row.matchMode === 'selected') {
      ingredient = all.find(food => String(food._id) === String(new ObjectId(row.matchId)));
      if (!ingredient) throw fail(409,'The chosen ingredient no longer exists. Review its match again.');
    } else if (row.matchMode === 'auto') {
      if (match.kind === 'ambiguous') throw fail(409,'More than one ingredient matches. Choose one or Keep separate.');
      ingredient = match.ingredient;
    }
    const storageId = Object.hasOwn(row,'storageId') ? row.storageId : null;
    await touchStorage(database,session,storageId);
    const batch = purchasedBatch({ ...row, storageId }, item._id);
    if (ingredient) {
      const existingBatches = stockOf(ingredient);
      const compatible = existingBatches.filter(batch => batch.unit === row.unit && (batch.packageSize || null) === (row.packageSize || null)).reduce((sum,batch)=>sum+batch.quantity,0);
      if (!Number.isFinite(compatible + row.quantity)) throw fail(400,'The quantity is too large. Enter a smaller purchased quantity.');
      const batches = [...existingBatches,batch];
      // Keep the identity/category, and every older batch, exactly as saved.
      ingredient = await inventory.findOneAndUpdate({ _id: ingredient._id },{ $set: { batches, stockVersion: 1 } },{ session, returnDocument: 'after', upsert: false });
    } else {
      const categoryId = Object.hasOwn(row,'categoryId') ? row.categoryId : categoryIdOf(item);
      await touchCategory(database,session,categoryId);
      ingredient = { _id: new ObjectId(), name: item.name, categoryId, batches: [batch], stockVersion: 1 };
      await inventory.insertOne(ingredient,{ session });
    }
    if (row.matchMode === 'selected' && row.rememberAlias) await rememberAlias(database,session,item.name,ingredient._id);
    const completedAt = new Date();
    const completed = { ...item, status: 'completed', pickedUp: true, ingredientId: ingredient._id, completedAt,
      purchase: { quantity: row.quantity, unit: row.unit, packageSize: row.packageSize || null, storageId, expiryDate: row.expiryDate, batchId: batch._id, ingredientId: ingredient._id, sourceIngredientId: item.ingredientId || null } };
    await receipts.insertOne({ _id: item._id, shoppingItem: completed, ingredientId: ingredient._id, batchId: batch._id, completedAt },{ session });
    // Save stock, its durable receipt, and list removal in the same transaction.
    // Any removal/receipt failure rolls back the inventory write as well.
    const removed = await shopping.deleteOne({ _id: item._id, status: { $ne: 'completed' }, ...(requirePicked ? { pickedUp: true } : {}) },{ session });
    if (!removed.deletedCount) throw fail(409,'This shopping item changed. Refresh the review before retrying.');
    return { shoppingItemId: row.shoppingItemId, ingredientId: ingredient._id, batchId: batch._id, alreadyCompleted: false, removed: true };
  });
}
async function transferPurchases(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw fail(400,'Review between 1 and 100 purchases per request.');
  if (new Set(rows.map(row => row?.shoppingItemId)).size !== rows.length) throw fail(400,'Each shopping item can appear only once in a review.');
  const results = [];
  for (const row of rows) {
    try { results.push({ ...await transferOne(row), success: true }); }
    catch(error) {
      if (![400,404,409].includes(error.status)) console.error(connectionErrorMessage(error));
      results.push({ shoppingItemId: row?.shoppingItemId, success: false, status: error.status || 500,
        error: [400,404,409].includes(error.status) ? error.message : 'Unable to save this purchase. Retry is safe; recorded items will not be added twice.' });
    }
  }
  return { results, recorded: results.filter(result => result.success).length, failed: results.filter(result => !result.success).length };
}
module.exports = { reviewPurchases, transferOne, transferPurchases, validateRow };
