import { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolvePlatformActor } from '../domain/auditActor';
import { getRequestLocale } from '../infra/locale';
import { attachProductTranslations, clearedLocales, parseProductTranslations, writeProductTranslations } from './product-translations';
import { parseBaseProductInput, type BaseProductInput } from '../domain/baseProducts';
import {
  isMemberImageRefusal, memberImageBodyParser, memberImageUploadRateLimit, parseMemberImageRequest,
} from './member-image-storage';
import {
  BASE_PRODUCT_IMAGE_COLUMNS, clearBaseProductImage, migrateBaseProductImageOnRename, storeBaseProductImage,
} from './base-product-image-storage';

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
  bp.description, bp.notes, bp.package_information, bp.tax_behavior, bp.image_url, bp.image_thumbnail_url,
  bp.created_at, bp.created_by, bp.modified_at, bp.modified_by`;

async function withTranslations(req: any, rows: any[]) {
  return attachProductTranslations('base', rows, getRequestLocale(req));
}

function shape(row: any) {
  return {
    ...row,
    amount: row.amount === null ? null : Number(row.amount),
    mandatory: Boolean(row.mandatory),
    one_time_purchase: Boolean(row.one_time_purchase),
  };
}

async function loadOne(id: unknown, req?: any) {
  const { rows } = await db.query<any>(
    `SELECT ${COLUMNS} FROM base_products bp WHERE bp.id = ? AND bp.deleted_at IS NULL`,
    [id],
  );
  if (!rows[0]) return null;
  return (await withTranslations(req ?? { headers: {} }, [shape(rows[0])]))[0];
}

function toInput(row: any): BaseProductInput {
  return {
    charge_type_code: row.charge_type_code, name: row.name, type: row.type, units: row.units,
    amount: row.amount, billing_frequency: row.billing_frequency, status: row.status,
    enrollment_status: row.enrollment_status, mandatory: row.mandatory,
    validity_days: row.validity_days, one_time_purchase: row.one_time_purchase,
    description: row.description, notes: row.notes, package_information: row.package_information,
    tax_behavior: row.tax_behavior,
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
    res.json(await withTranslations(req, rows.map(shape)));
  } catch (err) { next(err); }
});

platformBaseProductsRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const row = await loadOne(req.params.id, req);
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
    let translations: Record<string, { name: string; description: string | null }> = {};
    if (req.body?.translations !== undefined) {
      const p = parseProductTranslations(req.body.translations);
      if ('error' in p) return res.status(400).json({ error: p.error });
      translations = p.value;
    }
    const actor = resolvePlatformActor(req.superadminName);
    let id: number;
    try {
      const result = await db.query(
        `INSERT INTO base_products
           (charge_type_code, name, type, units, amount, billing_frequency, status,
            enrollment_status, mandatory, validity_days, one_time_purchase,
            description, notes, package_information, tax_behavior, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
        [v.charge_type_code, v.name, v.type, v.units, v.amount, v.billing_frequency, v.status,
          v.enrollment_status, v.mandatory ? 1 : 0, v.validity_days, v.one_time_purchase ? 1 : 0,
          v.description, v.notes, v.package_information, v.tax_behavior, actor],
      );
      id = result.insertId;
      await writeProductTranslations('base', db, id, translations);
    } catch (err: any) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A base product for this charge type or name already exists' });
      throw err;
    }
    const row = await loadOne(id, req);
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
    let translations: Record<string, { name: string; description: string | null }> | null = null;
    let cleared: string[] = [];
    if (req.body?.translations !== undefined) {
      const p = parseProductTranslations(req.body.translations);
      if ('error' in p) return res.status(400).json({ error: p.error });
      translations = p.value;
      cleared = clearedLocales(req.body.translations, p.value);
    }
    const actor = resolvePlatformActor(req.superadminName);
    try {
      await db.query(
        `UPDATE base_products
            SET charge_type_code = ?, name = ?, type = ?, units = ?, amount = ?, billing_frequency = ?,
                status = ?, enrollment_status = ?, mandatory = ?, validity_days = ?, one_time_purchase = ?,
                description = ?, notes = ?, package_information = ?, tax_behavior = ?,
                modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND deleted_at IS NULL`,
        [v.charge_type_code, v.name, v.type, v.units, v.amount, v.billing_frequency, v.status,
          v.enrollment_status, v.mandatory ? 1 : 0, v.validity_days, v.one_time_purchase ? 1 : 0,
          v.description, v.notes, v.package_information, v.tax_behavior, actor, existing.id],
      );
      if (translations) await writeProductTranslations('base', db, existing.id, translations, cleared);
    } catch (err: any) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A base product for this charge type or name already exists' });
      throw err;
    }
    // #2009: the image key carries the template's name, so a rename moves it.
    if (v.name !== existing.name && existing.image_url) {
      await migrateBaseProductImageOnRename({
        id: existing.id, name: v.name, image_url: existing.image_url, image_thumbnail_url: existing.image_thumbnail_url,
      });
    }
    const row = await loadOne(existing.id, req);
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

// ─── Image (#2009 stage 3) ────────────────────────────────────────────────────
// The only writers of a template's `image_url` / `image_thumbnail_url`, under
// `cordel/base_products/`. Processing and limits are the Member photo's.

async function loadForImage(req: any, res: any) {
  const { rows } = await db.query(
    `SELECT ${BASE_PRODUCT_IMAGE_COLUMNS} FROM base_products WHERE id = ? AND deleted_at IS NULL`,
    [req.params.id],
  );
  if (!rows[0]) { res.status(404).json({ error: 'Base product not found' }); return null; }
  return { id: rows[0].id, name: rows[0].name, image_url: rows[0].image_url, image_thumbnail_url: rows[0].image_thumbnail_url };
}

platformBaseProductsRouter.post('/:id/image', requireSuperadmin, memberImageUploadRateLimit, memberImageBodyParser, async (req, res, next) => {
  try {
    const parsed = await parseMemberImageRequest(req);
    if (isMemberImageRefusal(parsed)) return res.status(parsed.status).json(parsed.body);
    const baseProduct = await loadForImage(req, res);
    if (!baseProduct) return;
    const stored = await storeBaseProductImage({
      baseProduct, images: parsed, modifiedBy: resolvePlatformActor(req.superadminName),
    });
    if (isMemberImageRefusal(stored)) return res.status(stored.status).json(stored.body);
    recordAudit(req, {
      action: 'update', entityType: 'base_product', entityId: baseProduct.id, entityName: baseProduct.name,
      previous: { image_url: baseProduct.image_url }, next: { image_url: stored.image_url },
    });
    res.json(await loadOne(baseProduct.id, req));
  } catch (err) { next(err); }
});

platformBaseProductsRouter.delete('/:id/image', requireSuperadmin, async (req, res, next) => {
  try {
    const baseProduct = await loadForImage(req, res);
    if (!baseProduct) return;
    await clearBaseProductImage({ baseProduct, modifiedBy: resolvePlatformActor(req.superadminName) });
    recordAudit(req, {
      action: 'update', entityType: 'base_product', entityId: baseProduct.id, entityName: baseProduct.name,
      previous: { image_url: baseProduct.image_url }, next: { image_url: null },
    });
    res.json(await loadOne(baseProduct.id, req));
  } catch (err) { next(err); }
});
