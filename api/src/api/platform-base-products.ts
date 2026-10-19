import { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolvePlatformActor } from '../domain/auditActor';
import { parseBaseProductInput, type BaseProductInput } from '../domain/baseProducts';

/**
 * #1822 — Cordel → Base Products. The only writer of `base_products`, the
 * global templates `seedDefaultGymProducts()` copies into a newly created gym.
 * `products` is never touched here: a template edit or delete affects the gyms
 * created afterwards and none already generated. Every route is
 * `requireSuperadmin`; delete is soft, and nothing references a template, so
 * there is no integrity rule to refuse it.
 */
export const platformBaseProductsRouter = Router();

const COLUMNS = `bp.id, bp.charge_type_code, bp.name, bp.type, bp.units, bp.amount, bp.billing_frequency,
  bp.status, bp.enrollment_status, bp.mandatory, bp.validity_days, bp.one_time_purchase,
  bp.created_at, bp.created_by, bp.modified_at, bp.modified_by`;

function shape(row: any) {
  return {
    ...row,
    amount: row.amount === null ? null : Number(row.amount),
    mandatory: Boolean(row.mandatory),
    one_time_purchase: Boolean(row.one_time_purchase),
  };
}

async function loadOne(id: unknown) {
  const { rows } = await db.query<any>(
    `SELECT ${COLUMNS} FROM base_products bp WHERE bp.id = ? AND bp.deleted_at IS NULL`,
    [id],
  );
  return rows[0] ? shape(rows[0]) : null;
}

function toInput(row: any): BaseProductInput {
  return {
    charge_type_code: row.charge_type_code, name: row.name, type: row.type, units: row.units,
    amount: row.amount, billing_frequency: row.billing_frequency, status: row.status,
    enrollment_status: row.enrollment_status, mandatory: row.mandatory,
    validity_days: row.validity_days, one_time_purchase: row.one_time_purchase,
  };
}

/** A charge type code must name an `is_product` row of the global lookup. */
async function chargeTypeError(code: string | null): Promise<string | null> {
  if (code === null) return null;
  const { rows } = await db.query<any>('SELECT id FROM charge_types WHERE code = ? AND is_product = 1', [code]);
  return rows[0] ? null : 'charge_type_code does not name a product charge type';
}

platformBaseProductsRouter.get('/', requireSuperadmin, async (req, res, next) => {
  try {
    const params: unknown[] = [];
    let where = 'bp.deleted_at IS NULL';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      where += ' AND (bp.name LIKE ? OR bp.charge_type_code LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    for (const key of ['status', 'type', 'enrollment_status'] as const) {
      const v = req.query[key];
      if (typeof v === 'string' && v) { where += ` AND bp.${key} = ?`; params.push(v); }
    }
    const { rows } = await db.query<any>(
      `SELECT ${COLUMNS} FROM base_products bp WHERE ${where} ORDER BY bp.name ASC`, params,
    );
    res.json(rows.map(shape));
  } catch (err) { next(err); }
});

platformBaseProductsRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const row = await loadOne(req.params.id);
    if (!row) return res.status(404).json({ error: 'Base product not found' });
    res.json(row);
  } catch (err) { next(err); }
});

platformBaseProductsRouter.post('/', requireSuperadmin, async (req, res, next) => {
  try {
    const parsed = parseBaseProductInput(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const v = parsed.value;
    const ctError = await chargeTypeError(v.charge_type_code);
    if (ctError) return res.status(400).json({ error: ctError });
    const actor = resolvePlatformActor(req.superadminName);
    let id: number;
    try {
      const result = await db.query(
        `INSERT INTO base_products
           (charge_type_code, name, type, units, amount, billing_frequency, status,
            enrollment_status, mandatory, validity_days, one_time_purchase, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
        [v.charge_type_code, v.name, v.type, v.units, v.amount, v.billing_frequency, v.status,
          v.enrollment_status, v.mandatory ? 1 : 0, v.validity_days, v.one_time_purchase ? 1 : 0, actor],
      );
      id = result.insertId;
    } catch (err: any) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A base product for this charge type or name already exists' });
      throw err;
    }
    const row = await loadOne(id);
    recordAudit(req, { action: 'create', entityType: 'base_product', entityId: id, next: row });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

platformBaseProductsRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const existing = await loadOne(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Base product not found' });
    const parsed = parseBaseProductInput(req.body, toInput(existing));
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const v = parsed.value;
    if (v.charge_type_code !== existing.charge_type_code) {
      const ctError = await chargeTypeError(v.charge_type_code);
      if (ctError) return res.status(400).json({ error: ctError });
    }
    const actor = resolvePlatformActor(req.superadminName);
    try {
      await db.query(
        `UPDATE base_products
            SET charge_type_code = ?, name = ?, type = ?, units = ?, amount = ?, billing_frequency = ?,
                status = ?, enrollment_status = ?, mandatory = ?, validity_days = ?, one_time_purchase = ?,
                modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND deleted_at IS NULL`,
        [v.charge_type_code, v.name, v.type, v.units, v.amount, v.billing_frequency, v.status,
          v.enrollment_status, v.mandatory ? 1 : 0, v.validity_days, v.one_time_purchase ? 1 : 0, actor, existing.id],
      );
    } catch (err: any) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A base product for this charge type or name already exists' });
      throw err;
    }
    const row = await loadOne(existing.id);
    recordAudit(req, { action: 'update', entityType: 'base_product', entityId: existing.id, previous: existing, next: row });
    res.json(row);
  } catch (err) { next(err); }
});

platformBaseProductsRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const existing = await loadOne(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Base product not found' });
    const actor = resolvePlatformActor(req.superadminName);
    await db.query(
      `UPDATE base_products
          SET deleted_at = UTC_TIMESTAMP(), deleted_by = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [actor, actor, existing.id],
    );
    recordAudit(req, { action: 'soft_delete', entityType: 'base_product', entityId: existing.id, previous: existing });
    res.status(204).send();
  } catch (err) { next(err); }
});
