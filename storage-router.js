const express = require('express');
const { ObjectId } = require('mongodb');
const { getDatabase, withTransaction, connectionErrorMessage } = require('./db');
const { fail } = require('./categories');
const { validId, storageIdOf } = require('./storage');
const { stockOf } = require('./stock');
function createStorageRouter() {
  const router = express.Router();
  router.use((req,res,next) => { res.set('Cache-Control','no-store'); next(); });
  router.param('id',(req,res,next,id) => {
    if (!validId(id)) return res.status(400).json({ error: 'Choose a valid location. Unassigned cannot be edited.' });
    req.locationId = new ObjectId(id); next();
  });
  async function collection() {
    const result = (await getDatabase()).collection('storage_locations');
    await result.createIndex({ nameKey: 1 },{ unique: true, name: 'unique_storage_name' });
    return result;
  }
  function name(req,res,next) {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ error: 'Enter a location name with 1–100 characters.' });
    if (name.toLowerCase() === 'unassigned') return res.status(400).json({ error: 'Unassigned is the built-in fallback and cannot be edited.' });
    req.location = { name, nameKey: name.toLowerCase() }; next();
  }
  async function usage(database,category,session) {
    const ingredients = await database.collection('ingredients').find({}, { session }).toArray();
    const affected = ingredients.filter(item => stockOf(item).some(batch => String(storageIdOf(batch)) === String(category._id)));
    const shopping = await database.collection('shopping_items').find({}, { session }).toArray();
    const plans = shopping.filter(item => String(storageIdOf(item)) === String(category._id));
    return { affected, plans, inventoryCount: affected.length, shoppingCount: plans.length,
      batchCount: affected.reduce((n,item) => n + stockOf(item).filter(batch => String(storageIdOf(batch)) === String(category._id)).length,0) };
  }
  router.get('/',async(req,res,next) => { try {
    const locations = await (await collection()).find({}).sort({ name: 1, _id: 1 }).toArray();
    res.json({ locations, count: locations.length, unassigned: { _id: null, name: 'Unassigned' }, shared: true });
  } catch(error) { next(error); } });
  router.post('/',name,async(req,res,next) => { try {
    const result = await (await collection()).insertOne({ ...req.location, revision: 0 });
    res.status(201).json({ ...req.location, _id: result.insertedId });
  } catch(error) { next(error); } });
  router.put('/:id',name,async(req,res,next) => { try {
    const updated = await (await collection()).findOneAndUpdate({ _id: req.locationId },{ $set: req.location },{ returnDocument: 'after', upsert: false });
    if (!updated) throw fail(404,'Storage location not found. Refresh locations.');
    res.json(updated);
  } catch(error) { next(error); } });
  router.get('/:id',async(req,res,next) => { try {
    const database = await getDatabase();
    const location = await database.collection('storage_locations').findOne({ _id: req.locationId });
    if (!location) throw fail(404,'Storage location not found. Refresh locations.');
    const { inventoryCount, shoppingCount, batchCount } = await usage(database,location);
    res.json({ ...location, inventoryCount, shoppingCount, batchCount });
  } catch(error) { next(error); } });
  router.delete('/:id',async(req,res,next) => { try {
    await withTransaction(async(database,session) => {
      const location = await database.collection('storage_locations').findOne({ _id: req.locationId },{ session });
      if (!location) throw fail(404,'Storage location not found. Refresh locations.');
      const detail = await usage(database,location,session);
      if (req.body?.name !== location.name || req.body?.inventoryCount !== detail.inventoryCount || req.body?.shoppingCount !== detail.shoppingCount || req.body?.batchCount !== detail.batchCount) throw fail(409,'Location name or usage changed. Review the updated counts before deleting.');
      for (const item of detail.affected) {
        const batches = stockOf(item).map(batch => String(storageIdOf(batch)) === String(location._id) ? { ...batch, storageId: null } : batch);
        const update = { batches, stockVersion: 1 };
        if (String(storageIdOf(item)) === String(location._id)) update.storageId = null;
        await database.collection('ingredients').updateOne({ _id: item._id },{ $set: update },{ session });
      }
      for (const item of detail.plans) await database.collection('shopping_items').updateOne({ _id: item._id },{ $set: { storageId: null } },{ session });
      await database.collection('storage_locations').deleteOne({ _id: location._id },{ session });
    });
    res.status(204).end();
  } catch(error) { next(error); } });
  router.use((error,req,res,next) => {
    if ([400,404,409].includes(error.status)) return res.status(error.status).json({ error: error.message });
    if (error.code === 11000) return res.status(409).json({ error: 'A location with that name already exists.' });
    console.error(connectionErrorMessage(error));
    res.status(500).json({ error: 'Unable to save or load storage locations. Please try again.' });
  });
  return router;
}
module.exports = { createStorageRouter };
