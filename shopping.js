const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase, withTransaction, connectionErrorMessage } = require('./db');
const { validateIngredient } = require('./ingredient-validation');
const { categoryInput, categoryQuery, categoryIdOf, populateCategories, writeWithCategory } = require('./categories');
const { storageInput, storageIdOf, withReferences } = require('./storage');
const { populateInventory } = require('./stock');
const { resolveMatch, normalizeName } = require('./matching');
const { reviewPurchases, transferPurchases, transferOne } = require('./purchases');

const validId = id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
const requestError = (status, message) => Object.assign(new Error(message), { status });


async function pendingMatches(collection, ingredient, excludeId) {
  const database = await getDatabase();
  const pending = await collection.find({ status: { $ne: 'completed' } }).sort({ _id: 1 }).toArray();
  const inventory = await database.collection('ingredients').find({}).toArray();
  const aliases = await database.collection('ingredient_aliases').find({}).toArray();
  return pending.filter(item => String(item._id) !== String(excludeId) &&
    (String(item.ingredientId) === String(ingredient._id) || normalizeName(item.name) === normalizeName(ingredient.name) ||
     String(resolveMatch(item,inventory,aliases).ingredient?._id) === String(ingredient._id)));
}
async function withInventory(items) {
  const database = await getDatabase();
  const inventory = await populateInventory(await database.collection('ingredients').find({}).toArray());
  const aliases = await database.collection('ingredient_aliases').find({}).toArray();
  return populateCategories(items.map(item => {
    const match = resolveMatch(item,inventory,aliases);
    return { ...item, pickedUp: item.pickedUp === true, storageId: storageIdOf(item),
      ...(item.ingredientId || match.ingredient ? { currentInventory: match.ingredient || null } : {}) };
  }));
}

async function prepareLink(collection, item, excludeId) {
  if (!item.ingredientId) return null;
  const db = await getDatabase();
  const ingredient = await db.collection('ingredients').findOne({ _id: item.ingredientId });
  if (!ingredient) throw requestError(404, 'Ingredient not found. Refresh My Kitchen before adding it to your list.');
  // Legacy items have no status or link. No migration or replacement is needed.
  await collection.createIndex({ ingredientId: 1 }, {
    name: 'one_pending_item_per_ingredient', unique: true,
    partialFilterExpression: { status: 'pending', ingredientId: { $type: 'objectId' } }
  });
  return (await pendingMatches(collection,ingredient,excludeId))[0] || null;
}

function validateShoppingItem(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Send a shopping item as a JSON object with Content-Type: application/json.' });
  }

  const { name, plannedQuantity, unit } = body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return res.status(400).json({ error: 'Name is required and must contain 1–100 characters.' });
  }
  if (typeof plannedQuantity !== 'number' || !Number.isFinite(plannedQuantity) || plannedQuantity <= 0) {
    return res.status(400).json({ error: 'Planned quantity must be a positive number greater than zero.' });
  }
  if (typeof unit !== 'string' || !unit.trim() || unit.trim().length > 40) {
    return res.status(400).json({ error: 'Unit is required and must contain 1–40 characters.' });
  }

  if (Object.hasOwn(body,'packageSize') && body.packageSize !== null && (typeof body.packageSize !== 'string' || body.packageSize.trim().length > 60)) return res.status(400).json({error:'Package size must contain at most 60 characters.'});
  // Ordinary manual entries stay separate. Linking is an explicit action.
  req.shoppingItem = { name, plannedQuantity, unit: unit.trim(), ...(Object.hasOwn(body,'packageSize') ? {packageSize:body.packageSize?.trim() || null} : {}) };
  try { Object.assign(req.shoppingItem, categoryInput(body), storageInput(body)); } catch (error) { return res.status(error.status).json({ error: error.message }); }
  if (body.ingredientId !== undefined) {
    if (!validId(body.ingredientId)) return res.status(400).json({ error: 'Ingredient ID must be a valid MongoDB ObjectId.' });
    req.shoppingItem.ingredientId = new ObjectId(body.ingredientId);
    req.shoppingItem.status = 'pending';
  }
  next();
}

function validatePurchase(req, res, next) {
  if (!req.body || !['new', 'existing'].includes(req.body.destination)) {
    return res.status(400).json({ error: 'Choose a new inventory record or the linked existing record.' });
  }
  const input = { body: { ...req.body, name: 'Purchase' } };
  validateIngredient(input, res, () => {
    const { quantity, unit, storageId, expiryDate, categoryId, packageSize } = input.ingredient;
    req.purchase = { quantity, unit, storageId, expiryDate, ...(packageSize !== undefined ? {packageSize} : {}), destination: req.body.destination };
    if (req.body.destination === 'new' && categoryId !== undefined) req.purchase.categoryId = categoryId;
    next();
  });
}

function createShoppingRouter(getShoppingItems = async () => (await getDatabase()).collection('shopping_items')) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/review',async(req,res,next) => { try { res.json(await reviewPurchases()); } catch(error) { next(error); } });
  router.post('/transfer',async(req,res,next) => { try { res.json(await transferPurchases(req.body?.items)); } catch(error) { next(error); } });

  router.get('/', async (req, res, next) => {
    try {
      const categoryId = categoryQuery(req.query);
      const collection = await getShoppingItems();
      let filter = {};
      if (req.query.ingredientId !== undefined) {
        if (!validId(req.query.ingredientId)) return res.status(400).json({ error: 'Ingredient ID must be a valid MongoDB ObjectId.' });
        const db = await getDatabase();
        const ingredient = await db.collection('ingredients').findOne({ _id: new ObjectId(req.query.ingredientId) });
        if (!ingredient) return res.status(404).json({ error: 'Ingredient not found. Refresh My Kitchen.' });
        filter = { _id: { $in: (await pendingMatches(collection,ingredient)).map(item => item._id) } };
      }
      // Resolve legacy references before filtering so the API uses the same category
      // for both responses and matches, without rewriting old documents.
      const resolved = await withInventory(await collection.find(filter).sort({ name: 1, _id: 1 }).toArray());
      const shoppingItems = categoryId === undefined ? resolved : resolved.filter(item => String(item.categoryId) === String(categoryId));
      res.json({ count: shoppingItems.length, shoppingItems, pickedUpCount: await collection.countDocuments({ pickedUp: true, status: { $ne: 'completed' } }) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', validateShoppingItem, async (req, res, next) => {
    try {
      const collection = await getShoppingItems();
      const existing = await prepareLink(collection, req.shoppingItem);
      if (existing) return res.status(409).json({ error: 'This ingredient is already on your shopping list. Edit that item instead.', existingItem: (await withInventory([existing]))[0] });
      if (!Object.hasOwn(req.shoppingItem, 'categoryId')) {
        const linked = req.shoppingItem.ingredientId ? await (await getDatabase()).collection('ingredients').findOne({ _id: req.shoppingItem.ingredientId }) : null;
        req.shoppingItem.categoryId = linked ? categoryIdOf(linked) : null;
      }
      req.shoppingItem.pickedUp = false;
      const result = await withReferences(req.shoppingItem, (database,session) => collection.insertOne(req.shoppingItem, { session }));
      res.status(201).json((await withInventory([{ ...req.shoppingItem, _id: result.insertedId }]))[0]);
    } catch (error) {
      next(error);
    }
  });

  router.param('id', (req, res, next, id) => {
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      return res.status(400).json({ error: 'Shopping item ID must be a valid MongoDB ObjectId.' });
    }
    req.shoppingItemId = new ObjectId(id);
    next();
  });

  router.put('/:id', validateShoppingItem, async (req, res, next) => {
    try {
      const collection = await getShoppingItems();
      const current = await collection.findOne({ _id: req.shoppingItemId });
      if (!current) return res.status(404).json({ error: 'Shopping item not found. Refresh the list to see the current items.' });
      if (req.body.unit === current.unit) req.shoppingItem.unit = current.unit;
      if (req.shoppingItem.ingredientId && (current.status === 'completed' || (current.ingredientId && !current.ingredientId.equals(req.shoppingItem.ingredientId)))) {
        return res.status(409).json({ error: 'This item is already linked or completed. Refresh the list before editing it.' });
      }
      const existing = await prepareLink(collection, req.shoppingItem, req.shoppingItemId);
      if (existing) return res.status(409).json({ error: 'This ingredient is already on your shopping list. Edit that item instead.', existingItem: (await withInventory([existing]))[0] });
      const updated = await withReferences(req.shoppingItem, (database,session) => collection.findOneAndUpdate(
        { _id: req.shoppingItemId, ...(req.shoppingItem.ingredientId
          ? { status: { $ne: 'completed' }, ingredientId: current.ingredientId || { $exists: false } } : {}) },
        { $set: req.shoppingItem },
        { returnDocument: 'after', upsert: false, ...(session ? { session } : {}) }
      ));
      if (!updated) return res.status(404).json({ error: 'Shopping item not found. Refresh the list to see the current items.' });
      res.json((await withInventory([updated]))[0]);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id/picked-up',async(req,res,next) => {
    try {
      if (typeof req.body?.pickedUp !== 'boolean') throw requestError(400,'Choose whether this item was picked up.');
      const collection = await getShoppingItems();
      const updated = await collection.findOneAndUpdate({ _id: req.shoppingItemId, status: { $ne: 'completed' } },{ $set: { pickedUp: req.body.pickedUp } },{ returnDocument: 'after', upsert: false });
      if (!updated) throw requestError(409,'This item is already recorded or no longer exists. Refresh the list.');
      res.json((await withInventory([updated]))[0]);
    } catch(error) { next(error); }
  });

  // Keep the former endpoint available for older clients. It also appends a
  // separate batch and removes the saved item, just like the bulk endpoint.
  router.post('/:id/purchase',validatePurchase,async(req,res,next) => {
    try {
      const result = await transferOne({ ...req.purchase, expiryDate: req.purchase.expiryDate ? req.purchase.expiryDate.toISOString().slice(0,10) : null, storageId: req.purchase.storageId ? String(req.purchase.storageId) : null, ...(req.purchase.categoryId !== undefined ? { categoryId: req.purchase.categoryId ? String(req.purchase.categoryId) : null } : {}), shoppingItemId: String(req.shoppingItemId), matchMode: req.purchase.destination === 'new' ? 'separate' : 'auto' },{ requirePicked: false });
      const database = await getDatabase();
      const receipt = await database.collection('purchase_receipts').findOne({ _id: req.shoppingItemId });
      const item = receipt.shoppingItem;
      const ingredient = result.ingredientId ? await database.collection('ingredients').findOne({ _id: new ObjectId(String(result.ingredientId)) }) : null;
      res.json({ shoppingItem: (await withInventory([item]))[0], ingredient: ingredient ? (await populateInventory([ingredient]))[0] : null, alreadyCompleted: result.alreadyCompleted, removed: true });
    } catch(error) { next(error); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const collection = await getShoppingItems();
      const result = await collection.deleteOne({ _id: req.shoppingItemId });
      if (!result.deletedCount) return res.status(404).json({ error: 'Shopping item not found. Refresh the list to see the current items.' });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.use((error, req, res, next) => {
    if (error.status === 400 || error.status === 404 || error.status === 409) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error.code === 11000) {
      return res.status(409).json({ error: 'This ingredient was just added to your shopping list. Cancel and open Add to shopping list again to edit it.' });
    }
    console.error(connectionErrorMessage(error));
    const action = req.path.endsWith('/purchase') ? 'record the purchase' : req.method === 'DELETE' ? 'delete the shopping item' : ['POST', 'PUT'].includes(req.method) ? 'save the shopping item' : 'load shopping items';
    res.status(500).json({ error: 'Unable to ' + action + '. Please try again.' });
  });
  return router;
}

module.exports = { createShoppingRouter };
