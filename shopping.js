const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase, withTransaction, connectionErrorMessage } = require('./db');
const { validateIngredient } = require('./ingredient-validation');
const { categoryInput, categoryQuery, categoryIdOf, populateCategories, writeWithCategory, touchCategory } = require('./categories');

const validId = id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
const requestError = (status, message) => Object.assign(new Error(message), { status });


function matchingItems(ingredient) {
  const name = ingredient.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { status: { $ne: 'completed' }, $or: [
    { ingredientId: ingredient._id }, { name: { $regex: '^' + name + '$', $options: 'i' } }
  ] };
}

async function withInventory(items) {
  const ids = items.map(item => item.ingredientId).filter(id => id instanceof ObjectId);
  if (!ids.length) return populateCategories(items);
  const db = await getDatabase();
  const inventory = await db.collection('ingredients').find({ _id: { $in: ids } })
    .project({ name: 1, quantity: 1, unit: 1, storage: 1, expiryDate: 1, category: 1, categoryId: 1 }).toArray();
  const byId = new Map((await populateCategories(inventory)).map(ingredient => [String(ingredient._id), ingredient]));
  return populateCategories(items.map(item => ({ ...item, ...(item.ingredientId ? { currentInventory: byId.get(String(item.ingredientId)) || null } : {}) })));
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
  const filter = excludeId
    ? { ingredientId: ingredient._id, status: { $ne: 'completed' }, _id: { $ne: excludeId } }
    : matchingItems(ingredient);
  return collection.findOne(filter, { sort: { _id: 1 } });
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

  // Ordinary manual entries stay separate. Linking is an explicit action.
  req.shoppingItem = { name: name.trim(), plannedQuantity, unit: unit.trim() };
  try { Object.assign(req.shoppingItem, categoryInput(body)); } catch (error) { return res.status(error.status).json({ error: error.message }); }
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
    const { quantity, unit, storage, expiryDate, categoryId } = input.ingredient;
    req.purchase = { quantity, unit, storage, expiryDate, destination: req.body.destination };
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
        filter = matchingItems(ingredient);
      }
      // Resolve legacy references before filtering so the API uses the same category
      // for both responses and matches, without rewriting old documents.
      const resolved = await withInventory(await collection.find(filter).sort({ name: 1, _id: 1 }).toArray());
      const shoppingItems = categoryId === undefined ? resolved : resolved.filter(item => String(item.categoryId) === String(categoryId));
      res.json({ count: shoppingItems.length, shoppingItems });
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
      const result = await writeWithCategory(req.shoppingItem, session => collection.insertOne(req.shoppingItem, { session }));
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
      if (req.shoppingItem.ingredientId && (current.status === 'completed' || (current.ingredientId && !current.ingredientId.equals(req.shoppingItem.ingredientId)))) {
        return res.status(409).json({ error: 'This item is already linked or completed. Refresh the list before editing it.' });
      }
      const existing = await prepareLink(collection, req.shoppingItem, req.shoppingItemId);
      if (existing) return res.status(409).json({ error: 'This ingredient is already on your shopping list. Edit that item instead.', existingItem: (await withInventory([existing]))[0] });
      const updated = await writeWithCategory(req.shoppingItem, session => collection.findOneAndUpdate(
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

  router.post('/:id/purchase', validatePurchase, async (req, res, next) => {
    try {
      const result = await withTransaction(async (db, session) => {
        const shopping = db.collection('shopping_items');
        const inventory = db.collection('ingredients');
        const item = await shopping.findOne({ _id: req.shoppingItemId }, { session });
        if (!item) throw requestError(404, 'Shopping item not found. Refresh the list.');
        // The shopping ID is the durable idempotency key, even after a lost response
        // or a retry from another tab. Transactions retry write conflicts safely.
        if (item.status === 'completed') {
          const ingredient = item.purchase?.ingredientId
            ? await inventory.findOne({ _id: item.purchase.ingredientId }, { session }) : null;
          return { shoppingItem: { ...item, currentInventory: ingredient }, ingredient, alreadyCompleted: true };
        }

        const { quantity, unit, storage, expiryDate, destination } = req.purchase;
        let ingredient;
        if (destination === 'existing') {
          if (!item.ingredientId) throw requestError(409, 'This shopping item has no linked inventory record. Choose a new record.');
          const linked = await inventory.findOne({ _id: item.ingredientId }, { session });
          if (!linked) throw requestError(409, 'The linked inventory record no longer exists. Choose a new record.');
          if (linked.unit !== unit) throw requestError(409, 'Units must match exactly to combine quantities. Use the existing unit or create a new record.');
          if (typeof linked.quantity !== 'number' || !Number.isFinite(linked.quantity + quantity) || linked.quantity + quantity <= 0) {
            throw requestError(400, 'The combined quantity is not a valid number. Choose a new record.');
          }
          ingredient = await inventory.findOneAndUpdate(
            { _id: linked._id, unit },
            { $inc: { quantity }, $set: { storage, expiryDate } },
            { session, returnDocument: 'after', upsert: false }
          );
          if (!ingredient) throw requestError(409, 'The linked inventory record changed. Refresh the list and try again.');
        } else {
          const categoryId = Object.hasOwn(req.purchase, 'categoryId') ? req.purchase.categoryId : categoryIdOf(item);
          await touchCategory(db, session, categoryId);
          ingredient = { _id: new ObjectId(), name: item.name, quantity, unit, storage, expiryDate,
            categoryId };
          await inventory.insertOne(ingredient, { session });
        }

        // This write only happens after inventory succeeds; both commit together.
        const completedAt = new Date();
        const { categoryId: purchasedCategoryId, ...purchaseFields } = req.purchase;
        const shoppingItem = await shopping.findOneAndUpdate(
          { _id: item._id, status: { $ne: 'completed' } },
          { $set: { status: 'completed', completedAt, ingredientId: ingredient._id,
            purchase: { ...purchaseFields, ingredientId: ingredient._id, sourceIngredientId: item.ingredientId || null } } },
          { session, returnDocument: 'after', upsert: false }
        );
        if (!shoppingItem) throw requestError(409, 'The shopping item changed. Refresh the list before trying again.');
        return { shoppingItem: { ...shoppingItem, currentInventory: ingredient }, ingredient, alreadyCompleted: false };
      });
      result.shoppingItem = (await withInventory([result.shoppingItem]))[0];
      if (result.ingredient) result.ingredient = (await populateCategories([result.ingredient]))[0];
      res.json(result);
    } catch (error) {
      next(error);
    }
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
