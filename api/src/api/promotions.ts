import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { gymFetchOne, insertAndFetch } from '../infra/db-helpers';

const STATUSES = ['active', 'inactive'] as const;

export const promotionsRouter = Router();

promotionsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { status, active_on } = req.query as Record<string, string | undefined>;
  const where: string[] = ['gym_id = ?'];
  const params: any[] = [gymId];
  if (status) {
    if (!STATUSES.includes(status as any)) return res.status(400).json({ error: 'Invalid status' });
    where.push('status = ?'); params.push(status);
  }
  if (active_on) {
    where.push('starts_at <= ? AND ends_at >= ?');
    params.push(active_on, active_on);
  }
  const { rows } = await db.query(
    `SELECT * FROM promotions WHERE ${where.join(' AND ')} ORDER BY starts_at DESC`,
    params,
  );
  res.json(rows);
});

promotionsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const promo = await gymFetchOne('promotions', req.params.id, gymId);
  if (!promo) return res.status(404).json({ error: 'Promotion not found' });
  res.json(promo);
});

function validateBody(body: any) {
  if (body.starts_at && body.ends_at && new Date(body.starts_at) > new Date(body.ends_at)) {
    return 'ends_at must be on or after starts_at';
  }
  if (body.status && !STATUSES.includes(body.status)) return `status must be one of: ${STATUSES.join(', ')}`;
  return null;
}

promotionsRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, starts_at, ends_at, stackable, status } = req.body;
  if (!name?.trim() || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'name, starts_at and ends_at are required' });
  }
  const err = validateBody(req.body); if (err) return res.status(400).json({ error: err });
  try {
    const row = await insertAndFetch(
      `INSERT INTO promotions (gym_id, name, description, starts_at, ends_at, stackable, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [gymId, name.trim(), description ?? null, new Date(starts_at), new Date(ends_at), stackable ? 1 : 0, status ?? 'active'],
      'SELECT * FROM promotions WHERE id = ?',
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'promotion', entityId: row.id, entityName: row.name, next: row });
    res.status(201).json(row);
  } catch (e) { next(e); }
});

promotionsRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const err = validateBody(req.body); if (err) return res.status(400).json({ error: err });
  const { name, description, starts_at, ends_at, stackable, status } = req.body;
  try {
    const { rowCount } = await db.query(
      `UPDATE promotions SET
        name        = COALESCE(?, name),
        description = IF(?, ?, description),
        starts_at   = COALESCE(?, starts_at),
        ends_at     = COALESCE(?, ends_at),
        stackable   = IF(?, ?, stackable),
        status      = COALESCE(?, status)
       WHERE id = ? AND gym_id = ?`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        starts_at ? new Date(starts_at) : null,
        ends_at ? new Date(ends_at) : null,
        'stackable' in req.body ? 1 : 0, stackable ? 1 : 0,
        status ?? null,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Promotion not found' });
    const { rows } = await db.query('SELECT * FROM promotions WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    recordAudit(req, { action: 'update', entityType: 'promotion', entityId: req.params.id, entityName: rows[0].name, next: rows[0] });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

promotionsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows: existing } = await db.query('SELECT name FROM promotions WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  if (existing.length === 0) return res.status(404).json({ error: 'Promotion not found' });
  await db.query('DELETE FROM promotions WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  recordAudit(req, { action: 'delete', entityType: 'promotion', entityId: req.params.id, entityName: existing[0].name });
  res.status(204).send();
});
