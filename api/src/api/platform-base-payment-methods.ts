import { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolvePlatformActor } from '../domain/auditActor';
import { getRequestLocale as resolveLocale } from '../infra/locale';
import { paymentMethodImageName } from '../domain/paymentMethodImages';
import {
  clearPaymentMethodImage,
  migratePaymentMethodImageOnRename,
  storePaymentMethodImage,
} from './payment-method-image-storage';
import {
  isMemberImageRefusal,
  memberImageBodyParser,
  memberImageUploadRateLimit,
  parseMemberImageRequest,
} from './member-image-storage';
import {
  BASE_PAYMENT_METHOD_STATUSES,
  parseCode,
  parseStatus,
  parseTranslations,
  type TranslationsInput,
} from '../domain/basePaymentMethods';

/**
 * #1663 — Cordel → Base Payment Methods. The only writer of
 * `base_payment_methods`, a global catalogue (no `gym_id`), so every route is
 * `requireSuperadmin`. Delete is soft only: a historical reference to a method
 * must stay valid. `status` (enabled or not) and `deleted_at` are separate.
 * The `code` is the stable identifier and never changes after creation.
 */
export const platformBasePaymentMethodsRouter = Router();

interface MethodRow {
  id: number;
  code: string;
  status: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
  created_at: string;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

async function loadTranslations(ids: number[]) {
  const map = new Map<number, Record<string, { name: string; description: string | null }>>();
  if (ids.length === 0) return map;
  const { rows } = await db.query<any>(
    `SELECT base_payment_method_id AS id, locale, name, description
       FROM base_payment_method_translations
      WHERE base_payment_method_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  for (const r of rows) {
    const entry = map.get(r.id) ?? {};
    entry[r.locale] = { name: r.name, description: r.description };
    map.set(r.id, entry);
  }
  return map;
}

async function shape(rows: MethodRow[], locale: string) {
  const translations = await loadTranslations(rows.map((r) => r.id));
  return rows.map((r) => {
    const t = translations.get(r.id) ?? {};
    const shown = t[locale] ?? t.en ?? Object.values(t)[0];
    return {
      ...r,
      translations: t,
      display_name: shown?.name ?? r.code,
      display_description: t[locale]?.description ?? t.en?.description ?? null,
    };
  });
}

async function loadOne(id: unknown, locale: string) {
  const { rows } = await db.query<MethodRow>('SELECT * FROM base_payment_methods WHERE id = ?', [id]);
  if (!rows[0]) return null;
  return (await shape(rows, locale))[0];
}

platformBasePaymentMethodsRouter.get('/', requireSuperadmin, async (req, res) => {
  const locale = resolveLocale(req);
  const params: any[] = [];
  let where = 'm.deleted_at IS NULL';
  const status = req.query.status;
  if (typeof status === 'string' && (BASE_PAYMENT_METHOD_STATUSES as readonly string[]).includes(status)) {
    where += ' AND m.status = ?';
    params.push(status);
  }
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q) {
    where += ` AND (m.code LIKE ? OR EXISTS (
      SELECT 1 FROM base_payment_method_translations t
       WHERE t.base_payment_method_id = m.id AND t.name LIKE ?))`;
    params.push(`%${q}%`, `%${q}%`);
  }
  const { rows } = await db.query<MethodRow>(`SELECT m.* FROM base_payment_methods m WHERE ${where} ORDER BY m.id ASC`, params);
  res.json(await shape(rows, locale));
});

platformBasePaymentMethodsRouter.get('/:id', requireSuperadmin, async (req, res) => {
  const row = await loadOne(req.params.id, resolveLocale(req));
  if (!row || row.deleted_at) return res.status(404).json({ error: 'Payment method not found' });
  res.json(row);
});

async function writeTranslations(tx: { query: (sql: string, params?: any[]) => Promise<any> }, id: number, t: TranslationsInput) {
  for (const [locale, v] of Object.entries(t)) {
    await tx.query(
      `INSERT INTO base_payment_method_translations (base_payment_method_id, locale, name, description)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
      [id, locale, v.name, v.description],
    );
  }
}

platformBasePaymentMethodsRouter.post('/', requireSuperadmin, async (req, res) => {
  const body = req.body ?? {};
  const code = parseCode(body.code);
  if ('error' in code) return res.status(400).json({ error: code.error });
  const status = body.status === undefined ? { value: 'active' as const } : parseStatus(body.status);
  if ('error' in status) return res.status(400).json({ error: status.error });
  const translations = parseTranslations(body.translations);
  if ('error' in translations) return res.status(400).json({ error: translations.error });

  const actor = resolvePlatformActor(req.superadminName);
  try {
    const id = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO base_payment_methods (code, status, created_at, created_by)
         VALUES (?, ?, UTC_TIMESTAMP(), ?)`,
        [code.value, status.value, actor],
      );
      await writeTranslations(tx, insertId, translations.value);
      return insertId;
    });
    const row = await loadOne(id, resolveLocale(req));
    recordAudit(req, { action: 'create', entityType: 'base_payment_method', entityId: id, next: row });
    res.status(201).json(row);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A payment method with this code already exists' });
    throw err;
  }
});

platformBasePaymentMethodsRouter.put('/:id', requireSuperadmin, async (req, res) => {
  const body = req.body ?? {};
  if (body.status === undefined && body.translations === undefined && body.code === undefined) {
    return res.status(400).json({ error: 'At least one field must be provided' });
  }
  const locale = resolveLocale(req);
  const existing = await loadOne(req.params.id, locale);
  if (!existing || existing.deleted_at) return res.status(404).json({ error: 'Payment method not found' });

  // The code is the stable identifier: it may be echoed back but never changed.
  if (body.code !== undefined && body.code !== existing.code) {
    return res.status(400).json({ error: 'code cannot be changed after creation' });
  }
  let nextStatus = existing.status;
  if (body.status !== undefined) {
    const status = parseStatus(body.status);
    if ('error' in status) return res.status(400).json({ error: status.error });
    nextStatus = status.value;
  }
  let translations: TranslationsInput | null = null;
  if (body.translations !== undefined) {
    const parsed = parseTranslations(body.translations);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    translations = parsed.value;
  }

  const actor = resolvePlatformActor(req.superadminName);
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE base_payment_methods
          SET status = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [nextStatus, actor, existing.id],
    );
    if (translations) await writeTranslations(tx, existing.id, translations);
  });
  let row = await loadOne(existing.id, locale);
  // #1702: the image key carries the (English) name, so a rename moves it.
  if (row && row.image_url) {
    const nextName = paymentMethodImageName(row.translations, row.code);
    if (nextName !== paymentMethodImageName(existing.translations, existing.code)) {
      const moved = await migratePaymentMethodImageOnRename({
        id: row.id, name: nextName, image_url: row.image_url, image_thumbnail_url: row.image_thumbnail_url,
      });
      if (moved) row = await loadOne(existing.id, locale);
    }
  }
  recordAudit(req, { action: 'update', entityType: 'base_payment_method', entityId: existing.id, previous: existing, next: row });
  res.json(row);
});

platformBasePaymentMethodsRouter.delete('/:id', requireSuperadmin, async (req, res) => {
  const existing = await loadOne(req.params.id, resolveLocale(req));
  if (!existing || existing.deleted_at) return res.status(404).json({ error: 'Payment method not found' });
  const actor = resolvePlatformActor(req.superadminName);
  await db.query(
    `UPDATE base_payment_methods
        SET deleted_at = UTC_TIMESTAMP(), deleted_by = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE id = ? AND deleted_at IS NULL`,
    [actor, actor, existing.id],
  );
  recordAudit(req, { action: 'soft_delete', entityType: 'base_payment_method', entityId: existing.id, previous: existing });
  res.status(204).send();
});

/* ── Image (#1702 — WebP master 1080 × 1080 + thumbnail 256 × 256, cordel/payment_method/) ── */

async function loadForImage(req: any, res: any) {
  const row = await loadOne(req.params.id, resolveLocale(req));
  if (!row || row.deleted_at) { res.status(404).json({ error: 'Payment method not found' }); return null; }
  return {
    row,
    method: {
      id: row.id,
      name: paymentMethodImageName(row.translations, row.code),
      image_url: row.image_url,
      image_thumbnail_url: row.image_thumbnail_url,
    },
  };
}

platformBasePaymentMethodsRouter.post('/:id/image', requireSuperadmin, memberImageUploadRateLimit, memberImageBodyParser, async (req, res, next) => {
  try {
    const parsed = await parseMemberImageRequest(req);
    if (isMemberImageRefusal(parsed)) return res.status(parsed.status).json(parsed.body);
    const loaded = await loadForImage(req, res);
    if (!loaded) return;
    const stored = await storePaymentMethodImage({
      method: loaded.method, images: parsed, modifiedBy: resolvePlatformActor(req.superadminName),
    });
    if (isMemberImageRefusal(stored)) return res.status(stored.status).json(stored.body);
    recordAudit(req, {
      action: 'update', entityType: 'base_payment_method', entityId: loaded.row.id,
      previous: { image_url: loaded.row.image_url }, next: { image_url: stored.image_url },
    });
    res.json(await loadOne(loaded.row.id, resolveLocale(req)));
  } catch (err) { next(err); }
});

platformBasePaymentMethodsRouter.delete('/:id/image', requireSuperadmin, async (req, res, next) => {
  try {
    const loaded = await loadForImage(req, res);
    if (!loaded) return;
    await clearPaymentMethodImage({ method: loaded.method, modifiedBy: resolvePlatformActor(req.superadminName) });
    recordAudit(req, {
      action: 'update', entityType: 'base_payment_method', entityId: loaded.row.id,
      previous: { image_url: loaded.row.image_url }, next: { image_url: null },
    });
    res.json(await loadOne(loaded.row.id, resolveLocale(req)));
  } catch (err) { next(err); }
});
