const express = require('express');
const { getDatabase, connectionErrorMessage } = require('./db');

function createApp(getIngredients = async () => (await getDatabase()).collection('ingredients')) {
  const app = express();

  app.get('/', (req, res) => {
    res.json({
      message: 'Kitchen API is running',
      examples: [
        '/api/ingredients',
        '/api/ingredients?name=eggs',
        '/api/ingredients?storage=fridge'
      ]
    });
  });

  app.get('/api/ingredients', async (req, res, next) => {
    try {
      const filter = {};
      const { name, storage } = req.query;

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
      const results = await ingredients.find(filter)
        .sort({ name: 1, _id: 1 }).limit(100).toArray();
      res.json({ count: results.length, limit: 100, ingredients: results });
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found.' });
  });

  app.use((error, req, res, next) => {
    // Keep connection credentials and internal error details out of API responses.
    console.error(connectionErrorMessage(error));
    res.status(500).json({ error: 'Unable to load ingredients. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
