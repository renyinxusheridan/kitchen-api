const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase, withTransaction, connectionErrorMessage } = require('./db');
const { fail, references } = require('./categories');
function validateName(req, res, next) {
  if (!req.body || typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.trim().length > 100) return res.status(400).json({ error: 'Enter a category name with 1–100 characters.' });
  const name = req.body.name.trim();
  if (name.toLowerCase() === 'uncategorized') return res.status(400).json({ error: 'Uncategorized is the built-in fallback and cannot be edited.' });
  req.category = { name, nameKey: name.toLowerCase() }; next();
}
async function collection() {
  const result = (await getDatabase()).collection('categories');
  await result.createIndex({ nameKey: 1 }, { unique: true, name: 'unique_category_name' });
  return result;
}
function createCategoryRouter() {
  const router = express.Router();
  router.use((req,res,next) => { res.set('Cache-Control','no-store'); next(); });
  router.param('id',(req,res,next,id) => {
    if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(400).json({ error: 'Choose a valid category. Uncategorized cannot be edited.' });
    req.categoryId = new ObjectId(id); next();
  });
  router.get('/',async(req,res,next) => { try {
    const categories = await (await collection()).find({}).sort({ name: 1, _id: 1 }).toArray();
    res.json({ categories, count: categories.length, uncategorized: { _id: null, name: 'Uncategorized' }, shared: true });
  } catch(error) { next(error); } });
  router.post('/',validateName,async(req,res,next) => { try {
    const result = await (await collection()).insertOne({ ...req.category, revision: 0 });
    res.status(201).json({ ...req.category, _id: result.insertedId });
  } catch(error) { next(error); } });
  router.put('/:id',validateName,async(req,res,next) => { try {
    const category = await (await collection()).findOneAndUpdate({ _id: req.categoryId }, { $set: req.category }, { returnDocument: 'after', upsert: false });
    if (!category) throw fail(404,'Category not found. Refresh categories.');
    res.json(category);
  } catch(error) { next(error); } });
  router.get('/:id',async(req,res,next) => { try {
    const database = await getDatabase();
    const category = await database.collection('categories').findOne({ _id: req.categoryId });
    if (!category) throw fail(404,'Category not found. Refresh categories.');
    const inventoryCount = await database.collection('ingredients').countDocuments(references(category));
    const shoppingCount = await database.collection('shopping_items').countDocuments(references(category));
    res.json({ ...category, inventoryCount, shoppingCount });
  } catch(error) { next(error); } });
  router.delete('/:id',async(req,res,next) => { try {
    await withTransaction(async(database,session) => {
      const categories = database.collection('categories');
      const category = await categories.findOne({ _id: req.categoryId }, { session });
      if (!category) throw fail(404,'Category not found. Refresh categories.');
      const filter = references(category);
      const inventoryCount = await database.collection('ingredients').countDocuments(filter,{ session });
      const shoppingCount = await database.collection('shopping_items').countDocuments(filter,{ session });
      if (req.body?.name !== category.name || req.body?.inventoryCount !== inventoryCount || req.body?.shoppingCount !== shoppingCount) throw fail(409,'Category name or usage changed. Review the updated counts before deleting.');
      await database.collection('ingredients').updateMany(filter,{ $set: { categoryId: null } },{ session });
      await database.collection('shopping_items').updateMany(filter,{ $set: { categoryId: null } },{ session });
      await categories.deleteOne({ _id: category._id },{ session });
    });
    res.status(204).end();
  } catch(error) { next(error); } });
  router.use((error,req,res,next) => {
    if ([400,404,409].includes(error.status)) return res.status(error.status).json({ error: error.message });
    if (error.code === 11000) return res.status(409).json({ error: 'A category with that name already exists.' });
    console.error(connectionErrorMessage(error));
    res.status(500).json({ error: 'Unable to '+(req.method==='DELETE'?'delete':'save or load')+' categories. Please try again.' });
  });
  return router;
}
module.exports = { createCategoryRouter };
