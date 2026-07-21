import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { gymFetchOne, insertAndFetch } from '../infra/db-helpers';

const STATUSES = ['active', 'inactive'] as const;

const SORT_COLUMNS: Record<string, string> = {
  name: 'p.name',
  created_at: 'p.created_at',
  starts_at: 'p.starts_at',
  ends_at: 'p.ends_at',
  status: 'p.status',
};

export const promotionsRouter = Router();

promotionsRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { status, active_on } = req.query as Record<string, string | undefined>;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const createdBy = req.query.created_by == null || req.query.created_by === ''
    ? null : Number(req.query.created_by);
  if (createdBy !== null && !Number.isInteger(createdBy)) {
    return res.status(400).json({ error: 'created_by must be a membership id' });
  }
  const sortKey = typeof req.query.sort === 'string' && req.query.sort in SORT_COLUMNS
    ? req.query.sort : 'starts_at';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  const where: string[] = ['p.gym_id = ?'];
  const params: any[] = [gymId];

  if (status) {
    if (!STATUSES.includes(status as any)) return res.status(400).json({ error: 'Invalid status' });
    where.push('p.status = ?'); params.push(status);
  }
  if (active_on) {
    where.push('p.starts_at <= ? AND p.ends_at >= ?');
    params.push(active_on, active_on);
  }
  if (q) {
    where.push('(p.name LIKE ? OR p.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (createdBy !== null) {
    where.push('p.created_by_membership_id = ?'); params.push(createdBy);
  }

  try {
    const { rows } = await db.query(
      `SELECT p.*, gm.name AS created_by_name
       FROM promotions p
       LEFT JOIN gym_memberships gm ON gm.id = p.created_by_membership_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${SORT_COLUMNS[sortKey]} ${dir}`,
      params,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

promotionsRouter.get('/created-by-options', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT gm.id AS membership_id, gm.name
       FROM promotions p
       JOIN gym_memberships gm ON gm.id = p.created_by_membership_id
       WHERE p.gym_id = ? AND gm.name IS NOT NULL
       ORDER BY gm.name ASC`,
      [gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
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
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, description, starts_at, ends_at, stackable, status } = req.body;
  if (!name?.trim() || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'name, starts_at and ends_at are required' });
  }
  const err = validateBody(req.body); if (err) return res.status(400).json({ error: err });
  try {
    const row = await insertAndFetch(
      `INSERT INTO promotions (gym_id, name, description, starts_at, ends_at, stackable, status, created_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, name.trim(), description ?? null, new Date(starts_at), new Date(ends_at), stackable ? 1 : 0, status ?? 'active', gymMembershipId ?? null],
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

promotionsRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: srcRows } = await db.query(
    'SELECT * FROM promotions WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if (srcRows.length === 0) return res.status(404).json({ error: 'Promotion not found' });
  const src = srcRows[0];

  let copyName = `${src.name} (Copy)`;
  const { rows: existing } = await db.query(
    'SELECT name FROM promotions WHERE gym_id = ? AND name LIKE ?',
    [gymId, `${src.name} (Copy%`],
  );
  if (existing.length > 0) copyName = `${src.name} (Copy ${existing.length + 1})`;

  try {
    let newId: number;
    await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO promotions (gym_id, name, description, starts_at, ends_at, stackable, status, created_by_membership_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, copyName, src.description, src.starts_at, src.ends_at, src.stackable, src.status, gymMembershipId ?? null],
      );
      newId = insertId;

      const { rows: cbs } = await tx.query(
        'SELECT * FROM promotion_charge_benefits WHERE promotion_id = ? AND gym_id = ?',
        [src.id, gymId],
      );
      for (const cb of cbs) {
        await tx.query(
          'INSERT INTO promotion_charge_benefits (gym_id, promotion_id, charge_type_id, action_type_id, value) VALUES (?, ?, ?, ?, ?)',
          [gymId, newId, cb.charge_type_id, cb.action_type_id, cb.value],
        );
      }

      const { rows: pbs } = await tx.query(
        'SELECT * FROM promotion_period_benefits WHERE promotion_id = ? AND gym_id = ?',
        [src.id, gymId],
      );
      for (const pb of pbs) {
        await tx.query(
          'INSERT INTO promotion_period_benefits (gym_id, promotion_id, membership_plan_id, action_type_id, value, duration_months) VALUES (?, ?, ?, ?, ?, ?)',
          [gymId, newId, pb.membership_plan_id, pb.action_type_id, pb.value, pb.duration_months],
        );
      }
    });

    const { rows } = await db.query('SELECT * FROM promotions WHERE id = ?', [newId!]);
    recordAudit(req, { action: 'create', entityType: 'promotion', entityId: newId!, entityName: copyName, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});
