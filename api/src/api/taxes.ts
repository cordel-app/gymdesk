import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';

export const taxesRouter = Router();

const SELECT = `
  SELECT
    tr.id,
    tr.gym_id,
    tr.name,
    tr.rate_percent,
    tr.is_system,
    tr.status,
    tr.deleted_at,
    tr.created_at,
    tr.modified_at,
    cb.id   AS created_by_membership_id,
    cb.name AS created_by_name,
    mb.id   AS modified_by_membership_id,
    mb.name AS modified_by_name
  FROM tax_rates tr
  LEFT JOIN gym_memberships cb ON cb.id = tr.created_by_membership_id
  LEFT JOIN gym_memberships mb ON mb.id = tr.modified_by_membership_id
`;

const VALID_STATUSES = ['active', 'inactive'] as const;

// ─── GET / ────────────────────────────────────────────────────────────────────

taxesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  if (status && !VALID_STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  try {
    const params: unknown[] = [gymId];
    let sql = `${SELECT} WHERE tr.gym_id = ? AND tr.deleted_at IS NULL`;
    if (status) { sql += ' AND tr.status = ?'; params.push(status); }
    sql += ' ORDER BY tr.is_system DESC, tr.name ASC';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

taxesRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `${SELECT} WHERE tr.id = ? AND tr.gym_id = ? AND tr.deleted_at IS NULL`,
      [req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── POST / — create custom tax rate ─────────────────────────────────────────

taxesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, rate_percent, status } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const rate = parseFloat(rate_percent);
  if (isNaN(rate) || rate < 0 || rate > 100) {
    return res.status(400).json({ error: 'rate_percent must be a number between 0 and 100' });
  }
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  try {
    const { insertId } = await db.query(
      `INSERT INTO tax_rates
         (gym_id, name, rate_percent, is_system, status, created_by_membership_id, modified_by_membership_id)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
      [gymId, name.trim(), rate, status || 'active', gymMembershipId, gymMembershipId],
    );
    const { rows } = await db.query(`${SELECT} WHERE tr.id = ?`, [insertId]);
    recordAudit(req, {
      action: 'create',
      entityType: 'tax_rate',
      entityId: String(insertId),
      entityName: name.trim(),
      next: { name: name.trim(), rate_percent: rate, status: status || 'active' },
    });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A tax rate with this name already exists.');
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

taxesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, rate_percent, status } = req.body;

  if (rate_percent !== undefined) {
    const rate = parseFloat(rate_percent);
    if (isNaN(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({ error: 'rate_percent must be a number between 0 and 100' });
    }
  }
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  try {
    const { rows: existing } = await db.query(
      'SELECT id, is_system FROM tax_rates WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });

    const { rowCount } = await db.query(
      `UPDATE tax_rates SET
         name                      = COALESCE(?, name),
         rate_percent              = COALESCE(?, rate_percent),
         status                    = COALESCE(?, status),
         modified_at               = UTC_TIMESTAMP(),
         modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        rate_percent != null ? parseFloat(rate_percent) : null,
        status ?? null,
        gymMembershipId,
        req.params.id,
        gymId,
      ],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });

    const { rows } = await db.query(`${SELECT} WHERE tr.id = ? AND tr.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, {
      action: 'update',
      entityType: 'tax_rate',
      entityId: String(req.params.id),
      entityName: rows[0]?.name,
      next: { name, rate_percent, status },
    });
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A tax rate with this name already exists.');
  }
});

// ─── POST /:id/activate ───────────────────────────────────────────────────────

taxesRouter.post('/:id/activate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE tax_rates SET status = 'active', modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [gymMembershipId, req.params.id, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(`${SELECT} WHERE tr.id = ? AND tr.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, { action: 'activate', entityType: 'tax_rate', entityId: String(req.params.id), entityName: rows[0]?.name });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── POST /:id/deactivate ─────────────────────────────────────────────────────

taxesRouter.post('/:id/deactivate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE tax_rates SET status = 'inactive', modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [gymMembershipId, req.params.id, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(`${SELECT} WHERE tr.id = ? AND tr.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, { action: 'deactivate', entityType: 'tax_rate', entityId: String(req.params.id), entityName: rows[0]?.name });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── DELETE /:id — soft-delete custom tax rates only ─────────────────────────

taxesRouter.delete('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId, actorName } = getTenantContext(req);
  try {
    const { rows: existing } = await db.query(
      'SELECT id, is_system, name FROM tax_rates WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    if (existing[0].is_system) return res.status(403).json({ error: 'System tax rates cannot be deleted.' });

    await db.query(
      `UPDATE tax_rates SET deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?, deleted_by_name = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [gymMembershipId, actorName, req.params.id, gymId],
    );
    recordAudit(req, {
      action: 'delete',
      entityType: 'tax_rate',
      entityId: String(req.params.id),
      entityName: existing[0].name,
    });
    res.status(204).send();
  } catch (err) { next(err); }
});
