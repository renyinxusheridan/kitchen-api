const { ObjectId } = require('mongodb');
const normalizeName = name => String(name || '').trim().replace(/\s+/g,' ').toLowerCase();
// Deliberately limited food vocabulary. Never remove an arbitrary final “s”.
const pairs = 'egg:eggs apple:apples banana:bananas orange:oranges carrot:carrots onion:onions tomato:tomatoes potato:potatoes pepper:peppers lemon:lemons lime:limes mushroom:mushrooms cucumber:cucumbers avocado:avocados bean:beans pea:peas grape:grapes berry:berries strawberry:strawberries blueberry:blueberries loaf:loaves breast:breasts thigh:thighs'.split(' ');
const singular = new Map(pairs.flatMap(pair => { const [one,many] = pair.split(':'); return [[one,one],[many,one]]; }));
function conservativeName(name) {
  const parts = normalizeName(name).split(' ');
  parts[parts.length-1] = singular.get(parts.at(-1)) || parts.at(-1);
  return parts.join(' ');
}
function resolveMatch(item, inventory, aliases = []) {
  const linked = inventory.find(food => String(food._id) === String(item.ingredientId));
  if (linked) return { kind: 'linked', ingredient: linked };
  const normalized = normalizeName(item.name);
  const alias = aliases.find(alias => alias._id === normalized);
  const confirmed = alias && inventory.find(food => String(food._id) === String(alias.ingredientId));
  if (confirmed) return { kind: 'alias', ingredient: confirmed };
  const exact = inventory.filter(food => normalizeName(food.name) === normalized);
  const candidates = exact.length ? exact : inventory.filter(food => conservativeName(food.name) === conservativeName(item.name));
  if (candidates.length === 1) return { kind: exact.length ? 'exact' : 'plural', ingredient: candidates[0] };
  return candidates.length ? { kind: 'ambiguous', candidates } : { kind: 'new' };
}
async function rememberAlias(database,session,name,ingredientId) {
  await database.collection('ingredient_aliases').updateOne({ _id: normalizeName(name) },
    { $set: { ingredientId: new ObjectId(String(ingredientId)), displayName: name, confirmedAt: new Date() } },{ session, upsert: true });
}
module.exports = { normalizeName, conservativeName, resolveMatch, rememberAlias };
