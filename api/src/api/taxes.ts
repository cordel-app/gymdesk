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
    tr.description,
    tr.rate_percent,
    tr.is_system,
    tr.status,
    tr.deleted_at,
    tr.created_at,
    tr.created_by_membership_id,
    tr.created_by_name,
    tr.created_by_type,
    tr.modified_at,
    tr.modified_by_membership_id,
    tr.modified_by_name,
    tr.modified_by_type
  FROM tax_rates tr
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
  const { gymId, gymMembershipId, actorName, isSuperadmin } = getTenantContext(req);
  const { name, rate_percent, status, description } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const rate = parseFloat(rate_percent);
  if (isNaN(rate) || rate < 0 || rate > 100) {
    return res.status(400).json({ error: 'rate_percent must be a number between 0 and 100' });
  }
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  const actorType = isSuperadmin ? 'superadmin' : 'staff';
  try {
    const { insertId } = await db.query(
      `INSERT INTO tax_rates
         (gym_id, name, description, rate_percent, is_system, status,
          created_by_membership_id, created_by_name, created_by_type,
          modified_by_membership_id, modified_by_name, modified_by_type)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId, name.trim(), description?.trim() || null, rate, status || 'active',
        gymMembershipId, actorName, actorType,
        gymMembershipId, actorName, actorType,
      ],
    );
    const { rows } = await db.query(`${SELECT} WHERE tr.id = ?`, [insertId]);
    recordAudit(req, {
      action: 'create',
      entityType: 'tax_rate',
      entityId: String(insertId),
      entityName: name.trim(),
      next: { name: name.trim(), rate_percent: rate, status: status || 'active', description: description ?? null },
    });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A tax rate with this name already exists.');
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

// Sellable Items and Membership Plans currently referencing this tax rate. Taxes are never
// snapshotted onto a Membership at instantiation time, so this is the full set of entities an
// edit can affect — Membership instances are deliberately not counted (see #388).
async function getTaxImpact(gymId: string, taxRateId: string) {
  const { rows } = await db.query<{ sellable_items: number; membership_plans: number }>(
    `SELECT
       (SELECT COUNT(*) FROM gym_charges      WHERE tax_rate_id = ? AND gym_id = ? AND deleted_at IS NULL) AS sellable_items,
       (SELECT COUNT(*) FROM membership_plans WHERE tax_rate_id = ? AND gym_id = ? AND deleted_at IS NULL) AS membership_plans`,
    [taxRateId, gymId, taxRateId, gymId],
  );
  return {
    sellable_items: Number(rows[0].sellable_items),
    membership_plans: Number(rows[0].membership_plans),
  };
}

taxesRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId, actorName, isSuperadmin } = getTenantContext(req);
  const { name, rate_percent, status, description, confirmImpact } = req.body;

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

    // Determine the impact before persisting anything. A caller must explicitly confirm
    // (confirmImpact: true) once the count is non-zero — this can't be bypassed by only
    // sending the update fields, since the check runs unconditionally on every PUT.
    if (!confirmImpact) {
      const impact = await getTaxImpact(gymId, String(req.params.id));
      if (impact.sellable_items > 0 || impact.membership_plans > 0) {
        return res.status(409).json({ error: 'confirmation_required', impact });
      }
    }

    const actorType = isSuperadmin ? 'superadmin' : 'staff';
    const { rowCount } = await db.query(
      `UPDATE tax_rates SET
         name                      = COALESCE(?, name),
         description               = COALESCE(?, description),
         rate_percent              = COALESCE(?, rate_percent),
         status                    = COALESCE(?, status),
         modified_at               = UTC_TIMESTAMP(),
         modified_by_membership_id = ?,
         modified_by_name          = ?,
         modified_by_type          = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name?.trim() ?? null,
        description ?? null,
        rate_percent != null ? parseFloat(rate_percent) : null,
        status ?? null,
        gymMembershipId,
        actorName,
        actorType,
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
      next: { name, rate_percent, status, description },
    });
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A tax rate with this name already exists.');
  }
});

// ─── POST /:id/activate ───────────────────────────────────────────────────────

taxesRouter.post('/:id/activate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId, actorName, isSuperadmin } = getTenantContext(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE tax_rates SET status = 'active', modified_at = UTC_TIMESTAMP(),
         modified_by_membership_id = ?, modified_by_name = ?, modified_by_type = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [gymMembershipId, actorName, isSuperadmin ? 'superadmin' : 'staff', req.params.id, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(`${SELECT} WHERE tr.id = ? AND tr.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, { action: 'activate', entityType: 'tax_rate', entityId: String(req.params.id), entityName: rows[0]?.name });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── POST /:id/deactivate ─────────────────────────────────────────────────────

taxesRouter.post('/:id/deactivate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId, actorName, isSuperadmin } = getTenantContext(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE tax_rates SET status = 'inactive', modified_at = UTC_TIMESTAMP(),
         modified_by_membership_id = ?, modified_by_name = ?, modified_by_type = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [gymMembershipId, actorName, isSuperadmin ? 'superadmin' : 'staff', req.params.id, gymId],
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
