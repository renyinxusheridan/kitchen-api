const { ObjectId } = require('mongodb');
const { getDatabase, withTransaction } = require('./db');
const { fail, touchCategory } = require('./categories');
const legacyLocations = {
  fridge: { _id: new ObjectId('6b0600000000000000000001'), name: 'Fridge' },
  freezer: { _id: new ObjectId('6b0600000000000000000002'), name: 'Freezer' },
  pantry: { _id: new ObjectId('6b0600000000000000000003'), name: 'Pantry' }
};
const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
function storageIdOf(record) {
  return Object.hasOwn(record, 'storageId') ? record.storageId : legacyLocations[record.storage]?._id || null;
}
function storageInput(body) {
  if (Object.hasOwn(body, 'storageId')) {
    if (body.storageId === null) return { storageId: null };
    if (!validId(body.storageId)) throw fail(400, 'Choose a storage location or Unassigned.');
    return { storageId: new ObjectId(body.storageId) };
  }
  if (Object.hasOwn(body, 'storage')) {
    if (!Object.hasOwn(legacyLocations, body.storage)) throw fail(400, 'Choose a saved storage location or Unassigned.');
    return { storage: body.storage, storageId: legacyLocations[body.storage]._id };
  }
  return {};
}
async function touchStorage(database, session, storageId) {
  if (!storageId) return;
  const result = await database.collection('storage_locations').updateOne({ _id: storageId }, { $inc: { revision: 1 } }, { session });
  if (!result.matchedCount) throw fail(409, 'That storage location no longer exists. Refresh locations and choose again.');
}
async function withReferences(record, work) {
  return withTransaction(async (database, session) => {
    await database.collection('_workflow_locks').updateOne({ _id: 'inventory-matching' },{ $inc: { revision: 1 } },{ session, upsert: true });
    await touchCategory(database, session, record.categoryId);
    await touchStorage(database, session, record.storageId);
    return work(database, session);
  });
}
async function locationMap() {
  const records = await (await getDatabase()).collection('storage_locations').find({}).toArray();
  return new Map(records.map(record => [String(record._id), record]));
}
module.exports = { legacyLocations, validId, storageIdOf, storageInput, touchStorage, withReferences, locationMap };
