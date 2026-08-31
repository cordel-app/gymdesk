import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { handleDupEntry } from '../infra/db-helpers';

export const sellableItemsRouter = Router();

const SELECT = `
  SELECT
    gc.id,
    gc.gym_id,
    gc.charge_type_id,
    ct.code            AS charge_type_code,
    ct.name            AS charge_type_name,
    gc.name,
    gc.type,
    gc.units,
    gc.status,
    gc.is_system,
    gc.description,
    gc.amount,
    gc.currency,
    gc.billing_frequency,
    gc.availability,
    gc.notes,
    gc.package_information,
    gc.validity_days,
    gc.tax_rate_id,
    gc.tax_behavior,
    tr.name            AS tax_rate_name,
    tr.rate_percent    AS tax_rate_percent,
    gc.deleted_at,
    gc.class_package_id,
    gc.created_at,
    gc.modified_at,
    cb.id   AS created_by_membership_id,
    cb.name AS created_by_name,
    mb.id   AS modified_by_membership_id,
    mb.name AS modified_by_name,
    db.id   AS deleted_by_membership_id,
    db.name AS deleted_by_name
  FROM gym_charges gc
  LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
  LEFT JOIN tax_rates tr ON tr.id = gc.tax_rate_id
  LEFT JOIN gym_memberships cb ON cb.id = gc.created_by_membership_id
  LEFT JOIN gym_memberships mb ON mb.id = gc.modified_by_membership_id
  LEFT JOIN gym_memberships db ON db.id = gc.deleted_by_membership_id
`;

const VALID_TYPES = ['fee', 'service', 'sessions', 'merchandise', 'other'] as const;
const VALID_STATUSES = ['active', 'inactive'] as const;
const VALID_FREQUENCIES = ['once', 'per_session', 'week', 'month', 'year'] as const;
const VALID_TAX_BEHAVIORS = ['inclusive', 'exclusive'] as const;

function validateUnits(units: any): string | null {
  if (units === undefined || units === null) return null;
  const n = Number(units);
  if (!Number.isInteger(n) || n <= 0) return 'units must be a positive integer';
  return null;
}

function computePriceFields(row: any) {
  const amount = row.amount != null ? parseFloat(row.amount) : null;
  const rate = row.tax_rate_percent != null ? parseFloat(row.tax_rate_percent) : null;
  const behavior = row.tax_behavior ?? 'inclusive';

  if (amount == null || rate == null) {
    return { amount_excl_tax: null, amount_incl_tax: null, applied_tax_rate: rate };
  }

  const factor = 1 + rate / 100;
  const amount_excl_tax = behavior === 'inclusive'
    ? parseFloat((amount / factor).toFixed(2))
    : parseFloat(amount.toFixed(2));
  const amount_incl_tax = behavior === 'exclusive'
    ? parseFloat((amount * factor).toFixed(2))
    : parseFloat(amount.toFixed(2));

  return { amount_excl_tax, amount_incl_tax, applied_tax_rate: rate };
}

function attachPriceFields(row: any) {
  return { ...row, ...computePriceFields(row) };
}

// ─── GET / ────────────────────────────────────────────────────────────────────

sellableItemsRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const type = typeof req.query.type === 'string' ? req.query.type : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  // legacy filter kept for backward compat
  const availability = typeof req.query.availability === 'string' ? req.query.availability : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : null;

  if (type && !VALID_TYPES.includes(type as any)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (status && !VALID_STATUSES.includes(status as any)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  try {
    const params: unknown[] = [gymId];
    let sql = `${SELECT} WHERE gc.gym_id = ? AND gc.deleted_at IS NULL`;
    if (type) { sql += ' AND gc.type = ?'; params.push(type); }
    if (status) { sql += ' AND gc.status = ?'; params.push(status); }
    if (availability) {
      const mapped = availability === 'available' ? 'active' : 'inactive';
      sql += ' AND gc.status = ?'; params.push(mapped);
    }
    if (q) { sql += ' AND (gc.name LIKE ? OR gc.description LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY gc.is_system DESC, gc.name ASC';
    const { rows } = await db.query(sql, params);
    res.json(rows.map(attachPriceFields));
  } catch (err) { next(err); }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

sellableItemsRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `${SELECT} WHERE gc.id = ? AND gc.gym_id = ?`,
      [req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(attachPriceFields(rows[0]));
  } catch (err) { next(err); }
});

// ─── POST / — create custom sellable item ─────────────────────────────────────

sellableItemsRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const {
    name, type, units, description, amount, billing_frequency, status, notes,
    package_information, validity_days, tax_rate_id, tax_behavior,
  } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!type || !VALID_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  if (billing_frequency && !VALID_FREQUENCIES.includes(billing_frequency)) {
    return res.status(400).json({ error: `billing_frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` });
  }
  if (tax_behavior && !VALID_TAX_BEHAVIORS.includes(tax_behavior)) {
    return res.status(400).json({ error: `tax_behavior must be one of: ${VALID_TAX_BEHAVIORS.join(', ')}` });
  }
  const unitsErr = validateUnits(units);
  if (unitsErr) return res.status(400).json({ error: unitsErr });

  try {
    const { insertId } = await db.query(
      `INSERT INTO gym_charges
         (gym_id, name, type, units, description, amount, currency, billing_frequency, status,
          is_system, notes, package_information, validity_days, tax_rate_id, tax_behavior,
          created_by_membership_id, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gymId,
        name.trim(),
        type,
        units != null ? Number(units) : null,
        description?.trim() || null,
        amount != null ? parseFloat(amount) : null,
        billing_frequency || null,
        status || 'active',
        notes?.trim() || null,
        package_information?.trim() || null,
        validity_days != null ? parseInt(validity_days, 10) : null,
        tax_rate_id != null ? Number(tax_rate_id) : null,
        tax_behavior || 'inclusive',
        gymMembershipId,
        gymMembershipId,
      ],
    );
    const { rows } = await db.query(`${SELECT} WHERE gc.id = ?`, [insertId]);
    recordAudit(req, {
      action: 'create',
      entityType: 'gym_charge',
      entityId: String(insertId),
      entityName: name.trim(),
      next: { name: name.trim(), type, units, amount, billing_frequency, status, tax_rate_id, tax_behavior },
    });
    res.status(201).json(attachPriceFields(rows[0]));
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A sellable item with this name already exists.');
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

sellableItemsRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const {
    description, amount, billing_frequency, notes, name, type, units, status,
    package_information, validity_days, tax_rate_id, tax_behavior,
  } = req.body;

  if (billing_frequency && !VALID_FREQUENCIES.includes(billing_frequency)) {
    return res.status(400).json({ error: `billing_frequency must be one of: ${VALID_FREQUENCIES.join(', ')}` });
  }
  if (type && !VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (tax_behavior && !VALID_TAX_BEHAVIORS.includes(tax_behavior)) {
    return res.status(400).json({ error: `tax_behavior must be one of: ${VALID_TAX_BEHAVIORS.join(', ')}` });
  }
  const unitsErr = validateUnits(units);
  if (unitsErr) return res.status(400).json({ error: unitsErr });

  try {
    const { rows: existing } = await db.query(
      'SELECT id, is_system, name AS current_name FROM gym_charges WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    const isSystem = existing[0].is_system;

    const { rowCount } = await db.query(
      `UPDATE gym_charges SET
         description               = COALESCE(?, description),
         amount                    = ?,
         billing_frequency         = ?,
         availability              = COALESCE(
           CASE WHEN ? = 'active' THEN 'available' WHEN ? = 'inactive' THEN 'unavailable' ELSE NULL END,
           availability
         ),
         status                    = COALESCE(?, status),
         notes                     = ?,
         name                      = COALESCE(IF(? = 0, ?, NULL), name),
         type                      = COALESCE(IF(? = 0, ?, NULL), type),
         units                     = IF(? = 0 AND ? IS NOT NULL, ?, units),
         package_information       = IF(? = 0, ?, package_information),
         validity_days             = IF(? = 0 AND ? IS NOT NULL, ?, validity_days),
         tax_rate_id               = COALESCE(?, tax_rate_id),
         tax_behavior              = COALESCE(?, tax_behavior),
         modified_at               = UTC_TIMESTAMP(),
         modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        description ?? null,
        amount ?? null,
        billing_frequency ?? null,
        status ?? null, status ?? null,
        status ?? null,
        notes ?? null,
        isSystem, name?.trim() ?? null,
        isSystem, type ?? null,
        isSystem, units != null ? Number(units) : null, units != null ? Number(units) : null,
        isSystem, package_information ?? null,
        isSystem, validity_days != null ? parseInt(validity_days, 10) : null, validity_days != null ? parseInt(validity_days, 10) : null,
        tax_rate_id != null ? Number(tax_rate_id) : null,
        tax_behavior ?? null,
        gymMembershipId,
        req.params.id,
        gymId,
      ],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });

    const { rows } = await db.query(`${SELECT} WHERE gc.id = ? AND gc.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, {
      action: 'update',
      entityType: 'gym_charge',
      entityId: String(req.params.id),
      entityName: rows[0]?.name ?? rows[0]?.charge_type_name,
      next: { description, amount, billing_frequency, notes, name, type, units, status, tax_rate_id, tax_behavior },
    });
    res.json(attachPriceFields(rows[0]));
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A sellable item with this name already exists.');
  }
});

// ─── POST /:id/activate ───────────────────────────────────────────────────────

sellableItemsRouter.post('/:id/activate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE gym_charges
       SET status = 'active', availability = 'available',
           modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [gymMembershipId, req.params.id, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(`${SELECT} WHERE gc.id = ? AND gc.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, { action: 'activate', entityType: 'gym_charge', entityId: String(req.params.id), entityName: rows[0]?.name ?? rows[0]?.charge_type_name });
    res.json(attachPriceFields(rows[0]));
  } catch (err) { next(err); }
});

// ─── POST /:id/deactivate ─────────────────────────────────────────────────────

sellableItemsRouter.post('/:id/deactivate', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    const { rowCount } = await db.query(
      `UPDATE gym_charges
       SET status = 'inactive', availability = 'unavailable',
           modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [gymMembershipId, req.params.id, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    const { rows } = await db.query(`${SELECT} WHERE gc.id = ? AND gc.gym_id = ?`, [req.params.id, gymId]);
    recordAudit(req, { action: 'deactivate', entityType: 'gym_charge', entityId: String(req.params.id), entityName: rows[0]?.name ?? rows[0]?.charge_type_name });
    res.json(attachPriceFields(rows[0]));
  } catch (err) { next(err); }
});

// ─── DELETE /:id — soft-delete custom items only ──────────────────────────────

sellableItemsRouter.delete('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId, actorName } = getTenantContext(req);
  try {
    const { rows: existing } = await db.query(
      'SELECT id, is_system, name FROM gym_charges WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    if (existing[0].is_system) return res.status(403).json({ error: 'System sellable items cannot be deleted.' });

    await db.query(
      `UPDATE gym_charges
       SET deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?, deleted_by_name = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [gymMembershipId, actorName, req.params.id, gymId],
    );
    recordAudit(req, {
      action: 'delete',
      entityType: 'gym_charge',
      entityId: String(req.params.id),
      entityName: existing[0].name,
    });
    res.status(204).send();
  } catch (err) { next(err); }
});
