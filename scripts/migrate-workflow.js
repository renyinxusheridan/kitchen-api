const { ObjectId } = require('mongodb');
const { legacyLocations } = require('../storage');
const { stockOf } = require('../stock');
async function migrateWorkflow(database, transact) {
  await database.collection('storage_locations').createIndex({ nameKey: 1 },{ unique: true, name: 'unique_storage_name' });
  await database.collection('_workflow_locks').updateOne({ _id: 'inventory-matching' },{ $setOnInsert: { revision: 0 } },{ upsert: true });
  return transact(async(db,session) => {
    const markers = db.collection('_migrations');
    const marker = await markers.findOne({ _id: 'grocery-workflow-v1' },{ session });
    if (!marker) {
      for (const [legacyKey, location] of Object.entries(legacyLocations)) {
        const sameName = await db.collection('storage_locations').findOne({ nameKey: location.name.toLowerCase() },{ session });
        if (!sameName) await db.collection('storage_locations').updateOne({ _id: location._id },{ $setOnInsert: { ...location, legacyKey, nameKey: location.name.toLowerCase(), revision: 0 } },{ session, upsert: true });
      }
    }
    let locations = await db.collection('storage_locations').find({}, { session }).toArray();
    const counts = { ingredients: 0, shopping_items: 0 };
    for (const collectionName of ['ingredients','shopping_items']) {
      for (const record of await db.collection(collectionName).find({}, { session }).toArray()) {
        const update = {};
        if (!Object.hasOwn(record,'storageId')) {
          const name = typeof record.storage === 'string' ? record.storage.trim() : '';
          let location = locations.find(location => location.legacyKey === record.storage || location.nameKey === name.toLowerCase());
          // Preserve even a previously hand-entered location; don't re-create a
          // deliberately deleted seeded location on a subsequent migration.
          if (!location && name && !marker) {
            location = { _id: new ObjectId(), name, nameKey: name.toLowerCase(), revision: 0 };
            await db.collection('storage_locations').insertOne(location,{ session }); locations.push(location);
          }
          update.storageId = location?._id || null;
        }
        if (collectionName === 'ingredients' && !Array.isArray(record.batches)) {
          update.batches = stockOf({ ...record, ...update });
          update.stockVersion = 1;
        }
        if (collectionName === 'shopping_items' && !Object.hasOwn(record,'pickedUp')) update.pickedUp = false;
        if (Object.keys(update).length) { await db.collection(collectionName).updateOne({ _id: record._id },{ $set: update },{ session }); counts[collectionName]++; }
      }
    }
    if (!marker) await markers.insertOne({ _id: 'grocery-workflow-v1', completedAt: new Date() },{ session });
    return counts;
  });
}
if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const db = require('../db');
  (async()=>{
    const database = await db.getDatabase();
    if (!process.argv.includes('--apply')) {
      console.log(JSON.stringify({ dryRun: true, database: database.databaseName,
        ingredients: await database.collection('ingredients').countDocuments({ batches: { $exists: false } }),
        shoppingItems: await database.collection('shopping_items').countDocuments({ pickedUp: { $exists: false } }),
        message: 'No records changed. Use --apply only on the intended database after backup/review.' }));
      return;
    }
    console.log(JSON.stringify(await migrateWorkflow(database, db.withTransaction)));
  })().catch(error=>{console.error(db.connectionErrorMessage(error));process.exitCode=1;}).finally(db.close);
}
module.exports = { migrateWorkflow };
