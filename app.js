const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase, connectionErrorMessage } = require('./db');
const { createShoppingRouter } = require('./shopping');

const { validateIngredient } = require('./ingredient-validation');
const { categories, ingredientResponse } = require('./categories');

function createApp(getIngredients = async () => (await getDatabase()).collection('ingredients')) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  app.use('/api/shopping-items', createShoppingRouter());

  app.get('/api/ingredients', async (req, res, next) => {
    try {
      const filter = {};
      const { name, storage, category } = req.query;

      // Accept text values only; do not pass user-supplied query objects to MongoDB.
      if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim() || name.length > 100) {
          return res.status(400).json({ error: 'name must contain 1–100 characters.' });
        }
        // Escape special characters so the search treats the name as ordinary text.
        const safeName = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.name = { $regex: safeName, $options: 'i' };
      }

      if (storage !== undefined) {
        if (typeof storage !== 'string' || !['fridge', 'freezer', 'pantry'].includes(storage)) {
          return res.status(400).json({ error: 'storage must be fridge, freezer, or pantry.' });
        }
        filter.storage = storage;
      }

      if (category !== undefined) {
        if (typeof category !== 'string' || !categories.includes(category)) {
          return res.status(400).json({ error: 'category must be protein, grains, fruits_vegetables, or other.' });
        }
        filter.category = category === 'other' ? { $in: ['other', null, ''] } : category;
      }
      const ingredients = await getIngredients();
      const results = await ingredients.find(filter)
        .sort({ name: 1, _id: 1 }).limit(100).toArray();
      res.json({ count: results.length, limit: 100, ingredients: results.map(ingredientResponse) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/ingredients', validateIngredient, async (req, res, next) => {
    try {
      req.ingredient.category ??= 'other';
      const ingredients = await getIngredients();
      const result = await ingredients.insertOne(req.ingredient);
      res.status(201).json({ ...req.ingredient, _id: result.insertedId });
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
      const updated = await ingredients.findOneAndUpdate(
        { _id: req.ingredientId },
        { $set: req.ingredient },
        { returnDocument: 'after', upsert: false }
      );
      if (!updated) return res.status(404).json({ error: 'Ingredient not found. Refresh the list to see the current inventory.' });
      res.json(ingredientResponse(updated));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/ingredients/:id', async (req, res, next) => {
    try {
      const ingredients = await getIngredients();
      const result = await ingredients.deleteOne({ _id: req.ingredientId });
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
    const subject = /^\/api\/shopping-items(?:\/|$)/.test(req.path) ? 'Shopping item' : 'Ingredient';
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON. Check the ' + subject.toLowerCase() + ' data and try again.' });
    }
    if (error.type === 'entity.too.large') {
      return res.status(400).json({ error: subject + ' data is too large. Keep the request under 10 KB.' });
    }
    // Keep connection credentials and internal error details out of API responses.
    console.error(connectionErrorMessage(error));
    const action = req.method === 'DELETE' ? 'delete the ingredient' : ['POST', 'PUT'].includes(req.method) ? 'save the ingredient' : 'load ingredients';
    res.status(500).json({ error: 'Unable to ' + action + '. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
