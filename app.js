const express = require('express');
const path = require('node:path');
const { ObjectId } = require('mongodb');
const { getDatabase, withTransaction, connectionErrorMessage } = require('./db');
const { createShoppingRouter } = require('./shopping');

const { validateIngredient } = require('./ingredient-validation');
const { categoryQuery, touchCategory, fail } = require('./categories');
const { createStorageRouter } = require('./storage-router');
const { legacyLocations, validId, touchStorage, withReferences } = require('./storage');
const { stockOf, populateInventory, compareExpiry } = require('./stock');
const { createCategoryRouter } = require('./category-router');

function createApp(getIngredients = async () => (await getDatabase()).collection('ingredients')) {
  const app = express();
  // Express owns `/` on Vercel; serve the page explicitly while assets use its CDN.
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.use(express.json({ limit: '128kb' }));
  app.use('/api/categories', createCategoryRouter());
  app.use('/api/storage-locations', createStorageRouter());
  app.use((req,res,next) => { res.set('Cache-Control','no-store'); next(); });
  app.use('/api/shopping-items', createShoppingRouter());

  app.get('/api/ingredients', async (req, res, next) => {
    try {
      const filter = {};
      const { name, storage } = req.query;
      const categoryId = categoryQuery(req.query);

      // Accept text values only; do not pass user-supplied query objects to MongoDB.
      if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim() || name.length > 100) {
          return res.status(400).json({ error: 'name must contain 1–100 characters.' });
        }
        // Escape special characters so the search treats the name as ordinary text.
        const safeName = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.name = { $regex: safeName, $options: 'i' };
      }

      let storageId;
      if (storage !== undefined) {
        if (typeof storage !== 'string' || !Object.hasOwn(legacyLocations,storage)) return res.status(400).json({ error: 'Choose a saved storage location.' });
        storageId = String(legacyLocations[storage]._id);
      }
      if (req.query.storageId !== undefined) {
        if (req.query.storageId !== 'null' && !validId(req.query.storageId)) return res.status(400).json({ error: 'Choose a saved storage location or Unassigned.' });
        storageId = req.query.storageId === 'null' ? 'null' : String(new ObjectId(req.query.storageId));
      }
      const ingredients = await getIngredients();
      const resolved = await populateInventory(await ingredients.find(filter).sort({ name: 1, _id: 1 }).toArray());
      const results = resolved.filter(item => (categoryId === undefined || String(item.categoryId) === String(categoryId)) &&
        (storageId === undefined || item.batches.some(batch => String(batch.storageId) === storageId))).sort(compareExpiry);
      res.json({ count: results.length, ingredients: results });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/ingredients', validateIngredient, async (req, res, next) => {
    try {
      req.ingredient.categoryId ??= null;
      req.ingredient.storageId ??= null;
      const record = { ...req.ingredient, _id: new ObjectId(), stockVersion: 1 };
      record.batches = [{ _id: new ObjectId(), quantity: record.quantity, unit: record.unit, storageId: record.storageId, expiryDate: record.expiryDate, ...(record.packageSize ? {packageSize:record.packageSize} : {}) }];
      const ingredients = await getIngredients();
      await withReferences(record, (database,session) => ingredients.insertOne(record, { session }));
      res.status(201).json((await populateInventory([record]))[0]);
    } catch (error) {
      next(error);
    }
  });

  // A strict ObjectId check prevents malformed IDs and query objects reaching MongoDB.
  app.param('id', (req, res, next, id) => {
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      return res.status(400).json({ error: 'Ingredient ID must be a valid MongoDB ObjectId.' });
    }
    req.ingredientId = new ObjectId(id);
    next();
  });

  app.put('/api/ingredients/:id', validateIngredient, async (req, res, next) => {
    try {
      const ingredients = await getIngredients();
      const updated = await withTransaction(async(database,session) => {
        await database.collection('_workflow_locks').updateOne({ _id: 'inventory-matching' },{ $inc: { revision: 1 } },{ session, upsert: true });
        const current = await ingredients.findOne({ _id: req.ingredientId },{ session });
        if (!current) throw fail(404,'Ingredient not found. Refresh My Kitchen.');
        const batches = stockOf(current);
        if (batches.length > 1 && !req.batchId) throw fail(409,'Choose the stock batch to edit. Quantities in different batches are kept separate.');
        const index = req.batchId ? batches.findIndex(batch => String(batch._id) === req.batchId) : 0;
        if (req.batchId && index < 0) throw fail(409,'That batch no longer exists. Refresh My Kitchen.');
        const { name, categoryId, quantity, unit: parsedUnit, expiryDate } = req.ingredient;
        const unit = req.body.unit === batches[index]?.unit ? batches[index].unit : parsedUnit;
        const storageId = Object.hasOwn(req.ingredient,'storageId') ? req.ingredient.storageId : batches[index]?.storageId || null;
        await touchStorage(database,session,storageId);
        if (categoryId !== undefined) await touchCategory(database,session,categoryId);
        const batch = { ...(batches[index] || { _id: new ObjectId() }), quantity, unit, expiryDate, storageId, ...(Object.hasOwn(req.ingredient,'packageSize') ? {packageSize:req.ingredient.packageSize} : {}) };
        if (!batches.length) batches.push(batch); else batches[index] = batch;
        const totals = new Map();
        for (const stock of batches) { const key = JSON.stringify([stock.unit,stock.packageSize || null]); const total = (totals.get(key) || 0) + stock.quantity; if (!Number.isFinite(total)) throw fail(400,'The batch quantity is too large. Enter a smaller quantity.'); totals.set(key,total); }
        return ingredients.findOneAndUpdate({ _id: current._id },{ $set: { name, batches, stockVersion: 1, ...(categoryId !== undefined ? { categoryId } : {}) } },{ session, returnDocument: 'after', upsert: false });
      });
      res.json((await populateInventory([updated]))[0]);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/ingredients/:id/batches/:batchId', async(req,res,next) => {
    try {
      if (!validId(req.params.batchId)) throw fail(400,'Choose a valid stock batch.');
      const batchId = String(new ObjectId(req.params.batchId));
      const ingredients = await getIngredients();
      const updated = await withTransaction(async(database,session) => {
        const item = await ingredients.findOne({ _id: req.ingredientId },{ session });
        if (!item) throw fail(404,'Ingredient not found.');
        const batches = stockOf(item);
        if (!batches.some(batch => String(batch._id) === batchId)) throw fail(404,'Stock batch not found. Refresh My Kitchen.');
        return ingredients.findOneAndUpdate({ _id: item._id },{ $set: { batches: batches.filter(batch => String(batch._id) !== batchId), stockVersion: 1 } },{ session, returnDocument: 'after' });
      });
      res.json((await populateInventory([updated]))[0]);
    } catch(error) { next(error); }
  });

  app.delete('/api/ingredients/:id', async (req, res, next) => {
    try {
      const ingredients = await getIngredients();
      const result = await withTransaction(async(database,session) => {
        await database.collection('_workflow_locks').updateOne({ _id: 'inventory-matching' },{ $inc: { revision: 1 } },{ session, upsert: true });
        return ingredients.deleteOne({ _id: req.ingredientId },{ session });
      });
      if (!result.deletedCount) return res.status(404).json({ error: 'Ingredient not found. Refresh the list to see the current inventory.' });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found.' });
  });

  app.use((error, req, res, next) => {
    if ([400,404,409].includes(error.status)) return res.status(error.status).json({ error: error.message });
    const subject = /^\/api\/shopping-items(?:\/|$)/.test(req.path) ? 'Shopping item' : 'Ingredient';
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON. Check the ' + subject.toLowerCase() + ' data and try again.' });
    }
    if (error.type === 'entity.too.large') {
      return res.status(400).json({ error: subject + ' data is too large. Keep the request under 128 KB.' });
    }
    // Keep connection credentials and internal error details out of API responses.
    console.error(connectionErrorMessage(error));
    const action = req.method === 'DELETE' ? 'delete the ingredient' : ['POST', 'PUT'].includes(req.method) ? 'save the ingredient' : 'load ingredients';
    res.status(500).json({ error: 'Unable to ' + action + '. Please try again.' });
  });

  return app;
}

// Vercel imports this entry point as the HTTP handler. Keep the factory available
// for the local server, the Netlify adapter, and isolated API tests.
module.exports = createApp();
module.exports.createApp = createApp;
