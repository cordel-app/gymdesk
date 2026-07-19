import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { gymFetchOne, handleDupEntry, insertAndFetch } from '../infra/db-helpers';

const STATUSES = ['active', 'inactive'] as const;

export const classPackagesRouter = Router();

classPackagesRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const params: any[] = [gymId];
  let sql = 'SELECT * FROM class_packages WHERE gym_id = ?';
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY name ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

classPackagesRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const row = await gymFetchOne('class_packages', req.params.id, gymId);
  if (!row) return res.status(404).json({ error: 'Class package not found' });
  res.json(row);
});

function validate(body: any) {
  const sessions = body.number_of_sessions != null ? parseInt(body.number_of_sessions, 10) : null;
  const validity = body.validity_days != null ? parseInt(body.validity_days, 10) : null;
  const price = body.price != null ? parseFloat(body.price) : null;
  if (sessions !== null && (isNaN(sessions) || sessions <= 0)) return 'number_of_sessions must be a positive integer';
  if (validity !== null && (isNaN(validity) || validity <= 0)) return 'validity_days must be a positive integer';
  if (price !== null && (isNaN(price) || price < 0)) return 'price must be a non-negative number';
  if (body.status && !STATUSES.includes(body.status)) return `status must be one of: ${STATUSES.join(', ')}`;
  return null;
}

classPackagesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, number_of_sessions, price, validity_days, status } = req.body;
  if (!name?.trim() || number_of_sessions == null || price == null || validity_days == null) {
    return res.status(400).json({ error: 'name, number_of_sessions, price and validity_days are required' });
  }
  const err = validate(req.body); if (err) return res.status(400).json({ error: err });
  try {
    const row = await insertAndFetch(
      'INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status) VALUES (?, ?, ?, ?, ?, ?)',
      [gymId, name.trim(), parseInt(number_of_sessions, 10), parseFloat(price), parseInt(validity_days, 10), status ?? 'active'],
      'SELECT * FROM class_packages WHERE id = ?',
      (id) => [id],
    );
    res.status(201).json(row);
  } catch (e: any) {
    handleDupEntry(e, res, next, 'A class package with this name already exists.');
  }
});

classPackagesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const err = validate(req.body); if (err) return res.status(400).json({ error: err });
  const { name, number_of_sessions, price, validity_days, status } = req.body;
  try {
    const { rowCount } = await db.query(
      `UPDATE class_packages SET
        name               = COALESCE(?, name),
        number_of_sessions = COALESCE(?, number_of_sessions),
        price              = COALESCE(?, price),
        validity_days      = COALESCE(?, validity_days),
        status             = COALESCE(?, status)
       WHERE id = ? AND gym_id = ?`,
      [
        name?.trim() ?? null,
        number_of_sessions != null ? parseInt(number_of_sessions, 10) : null,
        price != null ? parseFloat(price) : null,
        validity_days != null ? parseInt(validity_days, 10) : null,
        status ?? null,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Class package not found' });
    const { rows } = await db.query('SELECT * FROM class_packages WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (e: any) {
    handleDupEntry(e, res, next, 'A class package with this name already exists.');
  }
});

classPackagesRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query('DELETE FROM class_packages WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Class package not found' });
  res.status(204).send();
});
