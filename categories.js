const { ObjectId } = require('mongodb');
const { getDatabase, withTransaction } = require('./db');
const legacy = {
  protein: { _id: new ObjectId('6b0500000000000000000001'), name: 'Protein' },
  grains: { _id: new ObjectId('6b0500000000000000000002'), name: 'Grains' },
  fruits_vegetables: { _id: new ObjectId('6b0500000000000000000003'), name: 'Fruits & Vegetables' }
};
const categories = [...Object.keys(legacy), 'other']; // Transition support for older clients.
const fail = (status, message) => Object.assign(new Error(message), { status });
function categoryIdOf(record) {
  if (Object.hasOwn(record, 'categoryId')) return record.categoryId;
  return legacy[record.category]?._id || null;
}
function categoryInput(body) {
  if (Object.hasOwn(body, 'categoryId')) {
    if (body.categoryId === null) return { categoryId: null };
    if (typeof body.categoryId !== 'string' || !/^[a-f0-9]{24}$/i.test(body.categoryId)) throw fail(400, 'Choose a valid category or Uncategorized.');
    return { categoryId: new ObjectId(body.categoryId) };
  }
  if (Object.hasOwn(body, 'category')) {
    if (!categories.includes(body.category)) throw fail(400, 'Choose a valid category.');
    return { categoryId: legacy[body.category]?._id || null };
  }
  return {};
}
function categoryQuery(query) {
  if (Object.hasOwn(query, 'categoryId')) return categoryInput({ categoryId: query.categoryId === 'null' ? null : query.categoryId }).categoryId;
  if (Object.hasOwn(query, 'category')) return categoryInput({ category: query.category }).categoryId;
  return undefined;
}
function ingredientResponse(item, byId = new Map()) {
  if (!item) return item;
  const category = byId.get(String(categoryIdOf(item)));
  return { ...item, categoryId: category?._id || null, categoryName: category?.name || 'Uncategorized', category: category?.legacyKey || 'other' };
}
async function populateCategories(items) {
  const ids = items.map(categoryIdOf).filter(Boolean);
  const records = ids.length ? await (await getDatabase()).collection('categories').find({ _id: { $in: ids } }).toArray() : [];
  const byId = new Map(records.map(record => [String(record._id), record]));
  return items.map(item => ingredientResponse(item, byId));
}
async function touchCategory(database, session, categoryId) {
  if (!categoryId) return;
  // Serialize assignments against deletion by writing the category in the same
  // transaction. A read-only foreign-key check could race with deletion.
  const result = await database.collection('categories').updateOne({ _id: categoryId }, { $inc: { revision: 1 } }, { session });
  if (!result.matchedCount) throw fail(409, 'That category no longer exists. Refresh categories and choose again.');
}
async function writeWithCategory(record, operation) {
  if (!record.categoryId) return operation(undefined);
  return withTransaction(async (database, session) => {
    await touchCategory(database, session, record.categoryId);
    return operation(session);
  });
}
function references(category) {
  return category.legacyKey
    ? { $or: [{ categoryId: category._id }, { categoryId: { $exists: false }, category: category.legacyKey }] }
    : { categoryId: category._id };
}
module.exports = { legacy, categories, fail, categoryInput, categoryQuery, categoryIdOf, ingredientResponse, populateCategories, touchCategory, writeWithCategory, references };
