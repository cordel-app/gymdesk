import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

/**
 * DEPRECATED compatibility alias for the pre-P1.1 Fares API (#5).
 * Serves the old admin Fares page against the renamed membership_plans
 * table, mapping base_price <-> price. Removed in P1.7 (#11) together
 * with the old page.
 */
export const faresRouter = Router();

const COMPAT_SELECT = 'SELECT id, gym_id, name, base_price AS price, created_at FROM membership_plans';

faresRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${COMPAT_SELECT} WHERE gym_id = ? ORDER BY name ASC`, [gymId]);
  res.json(rows);
});

faresRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${COMPAT_SELECT} WHERE id = ? AND gym_id = ?`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Fare not found' });
  res.json(rows[0]);
});

faresRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, price } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
  const parsed = parseFloat(price);
  if (isNaN(parsed) || parsed < 0) return res.status(400).json({ error: 'price must be a non-negative number' });
  try {
    const { insertId } = await db.query(
      'INSERT INTO membership_plans (name, base_price, gym_id) VALUES (?, ?, ?)',
      [name.trim(), parsed, gymId],
    );
    const { rows } = await db.query(`${COMPAT_SELECT} WHERE id = ?`, [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A fare with this name already exists.' });
    next(err);
  }
});

faresRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, price } = req.body;
  const parsed = price != null ? parseFloat(price) : null;
  if (parsed !== null && (isNaN(parsed) || parsed < 0)) {
    return res.status(400).json({ error: 'price must be a non-negative number' });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE membership_plans SET
        name       = COALESCE(?, name),
        base_price = COALESCE(?, base_price)
       WHERE id = ? AND gym_id = ?`,
      [name?.trim() ?? null, parsed, req.params.id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Fare not found' });
    const { rows } = await db.query(`${COMPAT_SELECT} WHERE id = ? AND gym_id = ?`, [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A fare with this name already exists.' });
    next(err);
  }
});

faresRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM membership_plans WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Fare not found' });
  res.status(204).send();
});
