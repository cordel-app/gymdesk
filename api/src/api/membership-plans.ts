import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

const STATUSES = ['active', 'inactive'];

export const membershipPlansRouter = Router();

membershipPlansRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const { rows } = await db.query(
    `SELECT * FROM membership_plans WHERE gym_id = ?${status ? ' AND status = ?' : ''} ORDER BY name ASC`,
    status ? [gymId, status] : [gymId],
  );
  res.json(rows);
});

membershipPlansRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM membership_plans WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Plan not found' });
  res.json(rows[0]);
});

membershipPlansRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, base_price, status } = req.body;
  if (!name || base_price == null) return res.status(400).json({ error: 'name and base_price are required' });
  const parsed = parseFloat(base_price);
  if (isNaN(parsed) || parsed < 0) return res.status(400).json({ error: 'base_price must be a non-negative number' });
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  try {
    const { insertId } = await db.query(
      'INSERT INTO membership_plans (name, description, base_price, status, gym_id) VALUES (?, ?, ?, ?, ?)',
      [name.trim(), description ?? null, parsed, status ?? 'active', gymId],
    );
    const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A plan with this name already exists.' });
    next(err);
  }
});

membershipPlansRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, base_price, status } = req.body;
  const parsed = base_price != null ? parseFloat(base_price) : null;
  if (parsed !== null && (isNaN(parsed) || parsed < 0)) {
    return res.status(400).json({ error: 'base_price must be a non-negative number' });
  }
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE membership_plans SET
        name        = COALESCE(?, name),
        description = IF(?, ?, description),
        base_price  = COALESCE(?, base_price),
        status      = COALESCE(?, status)
       WHERE id = ? AND gym_id = ?`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        parsed, status ?? null,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Plan not found' });
    const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A plan with this name already exists.' });
    next(err);
  }
});

membershipPlansRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM membership_plans WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Plan not found' });
  res.status(204).send();
});
