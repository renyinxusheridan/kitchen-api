const { legacy } = require('../categories');
async function migrateCategories(database, transact) {
  await database.collection('categories').createIndex({ nameKey: 1 }, { unique: true, name: 'unique_category_name' });
  return transact(async(db,session) => {
    const markers = db.collection('_migrations');
    const marker = await markers.findOne({ _id: 'category-references-v1' },{ session });
    if (!marker) {
      for (const [legacyKey,category] of Object.entries(legacy)) {
        await db.collection('categories').updateOne({ _id: category._id }, { $setOnInsert: { ...category, legacyKey, nameKey: category.name.toLowerCase(), revision: 0 } },{ session, upsert: true });
      }
    }
    const live = await db.collection('categories').find({}, { session }).toArray();
    const known = new Set(live.map(category => String(category._id)));
    const counts = {};
    for (const name of ['ingredients','shopping_items']) {
      counts[name] = 0;
      const records = await db.collection(name).find({ categoryId: { $exists: false } },{ session }).toArray();
      for (const record of records) {
        const mapped = legacy[record.category]?._id;
        const categoryId = mapped && known.has(String(mapped)) ? mapped : null;
        const result = await db.collection(name).updateOne({ _id: record._id, categoryId: { $exists: false } }, { $set: { categoryId } },{ session });
        counts[name] += result.modifiedCount;
      }
    }
    if (!marker) await markers.insertOne({ _id: 'category-references-v1', completedAt: new Date() },{ session });
    return counts;
  });
}
if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const db = require('../db');
  (async()=>{ const database=await db.getDatabase(); console.log(JSON.stringify(await migrateCategories(database,db.withTransaction))); })()
    .catch(error=>{console.error(db.connectionErrorMessage(error));process.exitCode=1;}).finally(db.close);
}
module.exports = { migrateCategories };
