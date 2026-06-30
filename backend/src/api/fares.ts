import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

export const faresRouter = Router();

faresRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM fares WHERE gym_id = $1 ORDER BY name ASC',
    [gymId],
  );
  res.json(rows);
});

faresRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM fares WHERE id = $1 AND gym_id = $2',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Fare not found' });
  res.json(rows[0]);
});

faresRouter.post('/', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { name, price } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'name and price are required' });
  const parsed = parseFloat(price);
  if (isNaN(parsed) || parsed < 0) return res.status(400).json({ error: 'price must be a non-negative number' });
  const { rows } = await db.query(
    'INSERT INTO fares (name, price, gym_id) VALUES ($1, $2, $3) RETURNING *',
    [name.trim(), parsed, gymId],
  );
  res.status(201).json(rows[0]);
});

faresRouter.put('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { name, price } = req.body;
  const parsed = price != null ? parseFloat(price) : null;
  if (parsed !== null && (isNaN(parsed) || parsed < 0)) {
    return res.status(400).json({ error: 'price must be a non-negative number' });
  }
  const { rows } = await db.query(
    `UPDATE fares SET
      name  = COALESCE($1, name),
      price = COALESCE($2, price)
     WHERE id = $3 AND gym_id = $4 RETURNING *`,
    [name?.trim() ?? null, parsed, req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Fare not found' });
  res.json(rows[0]);
});

faresRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM fares WHERE id = $1 AND gym_id = $2',
    [req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Fare not found' });
  res.status(204).send();
});
