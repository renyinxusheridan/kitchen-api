const categories = ['protein', 'grains', 'fruits_vegetables', 'other'];

// Supply a read-time fallback without migrating or reclassifying stored records.
function ingredientResponse(ingredient) {
  return ingredient ? { ...ingredient, category: ingredient.category || 'other' } : ingredient;
}

module.exports = { categories, ingredientResponse };
