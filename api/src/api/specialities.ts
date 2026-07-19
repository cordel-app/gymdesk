import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { gymFetchOne, handleDupEntry, insertAndFetch } from '../infra/db-helpers';

export const specialitiesRouter = Router();

specialitiesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM specialities WHERE gym_id = ? ORDER BY name ASC',
    [gymId],
  );
  res.json(rows);
});

specialitiesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const row = await gymFetchOne('specialities', req.params.id, gymId);
  if (!row) return res.status(404).json({ error: 'Speciality not found' });
  res.json(row);
});

specialitiesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const row = await insertAndFetch(
      'INSERT INTO specialities (gym_id, name, description) VALUES (?, ?, ?)',
      [gymId, name.trim(), description ?? null],
      'SELECT * FROM specialities WHERE id = ?',
      (id) => [id],
    );
    res.status(201).json(row);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A speciality with this name already exists.');
  }
});

specialitiesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description } = req.body;
  try {
    const { rowCount } = await db.query(
      `UPDATE specialities SET
        name = COALESCE(?, name),
        description = IF(?, ?, description)
       WHERE id = ? AND gym_id = ?`,
      [name?.trim() ?? null, 'description' in req.body ? 1 : 0, description ?? null, req.params.id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Speciality not found' });
    const { rows } = await db.query('SELECT * FROM specialities WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A speciality with this name already exists.');
  }
});

specialitiesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query('DELETE FROM specialities WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Speciality not found' });
  res.status(204).send();
});
