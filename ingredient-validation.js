const { categoryInput } = require('./categories');

function validateIngredient(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Send an ingredient as a JSON object with Content-Type: application/json.' });
  }

  const { name, quantity, unit, storage, expiryDate } = body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return res.status(400).json({ error: 'Name is required and must contain 1–100 characters.' });
  }
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'Quantity must be a positive number greater than zero.' });
  }
  if (typeof unit !== 'string' || !unit.trim() || unit.trim().length > 40) {
    return res.status(400).json({ error: 'Unit is required and must contain 1–40 characters.' });
  }
  if (!['fridge', 'freezer', 'pantry'].includes(storage)) {
    return res.status(400).json({ error: 'Storage must be fridge, freezer, or pantry.' });
  }
  let category;
  try { category = categoryInput(body); } catch (error) { return res.status(error.status).json({ error: error.message }); }

  let parsedExpiry = null;
  if (expiryDate !== undefined && expiryDate !== null && expiryDate !== '') {
    if (typeof expiryDate !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      return res.status(400).json({ error: 'Expiry date must be a real date in YYYY-MM-DD format, or left empty.' });
    }
    parsedExpiry = new Date(expiryDate + 'T00:00:00.000Z');
    // Date parsing can roll impossible dates into the next month; reject that.
    if (Number.isNaN(parsedExpiry.getTime()) || parsedExpiry.toISOString().slice(0, 10) !== expiryDate) {
      return res.status(400).json({ error: 'Expiry date must be a real calendar date.' });
    }
  }

  // Omitted category stays out of $set so legacy clients preserve saved values.
  req.ingredient = { name: name.trim(), quantity, unit: unit.trim(), storage, expiryDate: parsedExpiry };
  Object.assign(req.ingredient, category);
  next();
}


module.exports = { validateIngredient };
