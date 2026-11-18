const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase, connectionErrorMessage } = require('./db');

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

  // Ignore extra fields and keep each item separate, even when names match.
  req.shoppingItem = { name: name.trim(), plannedQuantity, unit: unit.trim() };
  next();
}

function createShoppingRouter(getShoppingItems = async () => (await getDatabase()).collection('shopping_items')) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res, next) => {
    try {
      const collection = await getShoppingItems();
      const shoppingItems = await collection.find({}).sort({ name: 1, _id: 1 }).toArray();
      res.json({ count: shoppingItems.length, shoppingItems });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', validateShoppingItem, async (req, res, next) => {
    try {
      const collection = await getShoppingItems();
      const result = await collection.insertOne(req.shoppingItem);
      res.status(201).json({ ...req.shoppingItem, _id: result.insertedId });
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
      const updated = await collection.findOneAndUpdate(
        { _id: req.shoppingItemId },
        { $set: req.shoppingItem },
        { returnDocument: 'after', upsert: false }
      );
      if (!updated) return res.status(404).json({ error: 'Shopping item not found. Refresh the list to see the current items.' });
      res.json(updated);
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
    console.error(connectionErrorMessage(error));
    const action = req.method === 'DELETE' ? 'delete the shopping item' : ['POST', 'PUT'].includes(req.method) ? 'save the shopping item' : 'load shopping items';
    res.status(500).json({ error: 'Unable to ' + action + '. Please try again.' });
  });
  return router;
}

module.exports = { createShoppingRouter };
