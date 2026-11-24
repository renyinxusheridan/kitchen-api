const express = require('express');
const path = require('node:path');
const { ObjectId } = require('mongodb');
const { getDatabase, connectionErrorMessage } = require('./db');
const { createShoppingRouter } = require('./shopping');

const { validateIngredient } = require('./ingredient-validation');
const { categoryQuery, populateCategories, writeWithCategory } = require('./categories');
const { createCategoryRouter } = require('./category-router');

function createApp(getIngredients = async () => (await getDatabase()).collection('ingredients')) {
  const app = express();
  // Express owns `/` on Vercel; serve the page explicitly while assets use its CDN.
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.use(express.json({ limit: '10kb' }));
  app.use('/api/categories', createCategoryRouter());
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

      if (storage !== undefined) {
        if (typeof storage !== 'string' || !['fridge', 'freezer', 'pantry'].includes(storage)) {
          return res.status(400).json({ error: 'storage must be fridge, freezer, or pantry.' });
        }
        filter.storage = storage;
      }

      const ingredients = await getIngredients();
      const resolved = await populateCategories(await ingredients.find(filter).sort({ name: 1, _id: 1 }).toArray());
      const results = resolved.filter(item => categoryId === undefined || String(item.categoryId) === String(categoryId)).slice(0, 100);
      res.json({ count: results.length, limit: 100, ingredients: results });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/ingredients', validateIngredient, async (req, res, next) => {
    try {
      req.ingredient.categoryId ??= null;
      const ingredients = await getIngredients();
      const result = await writeWithCategory(req.ingredient, session => ingredients.insertOne(req.ingredient, { session }));
      res.status(201).json((await populateCategories([{ ...req.ingredient, _id: result.insertedId }]))[0]);
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
      const updated = await writeWithCategory(req.ingredient, session => ingredients.findOneAndUpdate(
        { _id: req.ingredientId },
        { $set: req.ingredient },
        { returnDocument: 'after', upsert: false, ...(session ? { session } : {}) }
      ));
      if (!updated) return res.status(404).json({ error: 'Ingredient not found. Refresh the list to see the current inventory.' });
      res.json((await populateCategories([updated]))[0]);
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
    if ([400,404,409].includes(error.status)) return res.status(error.status).json({ error: error.message });
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

// Vercel imports this entry point as the HTTP handler. Keep the factory available
// for the local server, the Netlify adapter, and isolated API tests.
module.exports = createApp();
module.exports.createApp = createApp;
