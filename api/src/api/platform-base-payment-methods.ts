import { Request, Router } from 'express';
import { allocateGlobalSlug } from './entity-slugs';
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
  slug: string;
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

export async function loadBasePaymentMethod(id: unknown, locale: string) {
  const { rows } = await db.query<MethodRow>('SELECT * FROM base_payment_methods WHERE id = ?', [id]);
  if (!rows[0]) return null;
  return (await shape(rows, locale))[0];
}

/** One method as the reads answer it: the row, its translations and its display name. */
export type BasePaymentMethod = NonNullable<Awaited<ReturnType<typeof loadBasePaymentMethod>>>;

/** Every method, deleted ones included, shaped as the reads answer them (#2952's export). */
export async function loadAllBasePaymentMethods(locale: string) {
  const { rows } = await db.query<MethodRow>('SELECT * FROM base_payment_methods ORDER BY slug ASC');
  return shape(rows, locale);
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
  const row = await loadBasePaymentMethod(req.params.id, resolveLocale(req));
  if (!row || row.deleted_at) return res.status(404).json({ error: 'Payment method not found' });
  res.json(row);
});

async function writeTranslations(tx: { query: (sql: string, params?: any[]) => Promise<any> }, id: number, t: TranslationsInput) {
  for (const [locale, v] of Object.entries(t)) {
    if (!v.name) {
      await tx.query('DELETE FROM base_payment_method_translations WHERE base_payment_method_id = ? AND locale = ?', [id, locale]);
      continue;
    }
    await tx.query(
      `INSERT INTO base_payment_method_translations (base_payment_method_id, locale, name, description)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
      [id, locale, v.name, v.description],
    );
  }
}

/** What a write answered: the row's id, or the HTTP refusal a route returns as is. */
export type BasePaymentMethodWriteResult =
  | { ok: true; id: number }
  | { ok: false; status: number; body: Record<string, unknown> };

type AuditRequest = Request & { superadminName?: string | null };

/**
 * Creates a method. The route lets the slug be generated from the English name;
 * #2952's import passes the slug its archive carries, so an exported method keeps
 * its identity in the database it is imported into.
 */
export async function createBasePaymentMethod(
  req: AuditRequest,
  body: Record<string, any>,
  opts: { slug?: string } = {},
): Promise<BasePaymentMethodWriteResult> {
  const code = parseCode(body.code);
  if ('error' in code) return { ok: false, status: 400, body: { error: code.error } };
  const status = body.status === undefined ? { value: 'active' as const } : parseStatus(body.status);
  if ('error' in status) return { ok: false, status: 400, body: { error: status.error } };
  const translations = parseTranslations(body.translations);
  if ('error' in translations) return { ok: false, status: 400, body: { error: translations.error } };

  const actor = resolvePlatformActor(req.superadminName ?? null);
  try {
    const id = await db.transaction(async (tx) => {
      // #2951: generated once from the English name (else the code); never rewritten.
      const slug = opts.slug ?? await allocateGlobalSlug(
        'base_payment_methods', translations.value.en?.name || code.value, tx,
      );
      const { insertId } = await tx.query(
        `INSERT INTO base_payment_methods (code, slug, status, created_at, created_by)
         VALUES (?, ?, ?, UTC_TIMESTAMP(), ?)`,
        [code.value, slug, status.value, actor],
      );
      await writeTranslations(tx, insertId, translations.value);
      return insertId;
    });
    const row = await loadBasePaymentMethod(id, resolveLocale(req));
    recordAudit(req, { action: 'create', entityType: 'base_payment_method', entityId: id, next: row });
    return { ok: true, id };
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') {
      return { ok: false, status: 409, body: { error: 'A payment method with this code already exists' } };
    }
    throw err;
  }
}

/**
 * Writes a method's status and translations. The code and the slug never move;
 * the image key carries the English name, so a rename moves it (#1702).
 */
export async function updateBasePaymentMethod(
  req: AuditRequest,
  existing: BasePaymentMethod,
  body: Record<string, any>,
): Promise<BasePaymentMethodWriteResult> {
  if (body.status === undefined && body.translations === undefined && body.code === undefined) {
    return { ok: false, status: 400, body: { error: 'At least one field must be provided' } };
  }
  const locale = resolveLocale(req);
  // The code is the stable identifier: it may be echoed back but never changed.
  if (body.code !== undefined && body.code !== existing.code) {
    return { ok: false, status: 400, body: { error: 'code cannot be changed after creation' } };
  }
  let nextStatus = existing.status;
  if (body.status !== undefined) {
    const status = parseStatus(body.status);
    if ('error' in status) return { ok: false, status: 400, body: { error: status.error } };
    nextStatus = status.value;
  }
  let translations: TranslationsInput | null = null;
  if (body.translations !== undefined) {
    const parsed = parseTranslations(body.translations);
    if ('error' in parsed) return { ok: false, status: 400, body: { error: parsed.error } };
    translations = parsed.value;
  }

  const actor = resolvePlatformActor(req.superadminName ?? null);
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE base_payment_methods
          SET status = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [nextStatus, actor, existing.id],
    );
    if (translations) await writeTranslations(tx, existing.id, translations);
  });
  let row = await loadBasePaymentMethod(existing.id, locale);
  // #1702: the image key carries the (English) name, so a rename moves it.
  if (row && row.image_url) {
    const nextName = paymentMethodImageName(row.translations, row.code);
    if (nextName !== paymentMethodImageName(existing.translations, existing.code)) {
      const moved = await migratePaymentMethodImageOnRename({
        id: row.id, name: nextName, image_url: row.image_url, image_thumbnail_url: row.image_thumbnail_url,
      });
      if (moved) row = await loadBasePaymentMethod(existing.id, locale);
    }
  }
  recordAudit(req, { action: 'update', entityType: 'base_payment_method', entityId: existing.id, previous: existing, next: row });
  return { ok: true, id: existing.id };
}

/**
 * Processes the request's picture and stores it as the method's image (the
 * editor's upload and #2952's import both write through this).
 */
export async function storeBasePaymentMethodImage(
  req: AuditRequest,
  existing: BasePaymentMethod,
): Promise<BasePaymentMethodWriteResult> {
  const parsed = await parseMemberImageRequest(req);
  if (isMemberImageRefusal(parsed)) return { ok: false, status: parsed.status, body: parsed.body };
  const stored = await storePaymentMethodImage({
    method: {
      id: existing.id,
      name: paymentMethodImageName(existing.translations, existing.code),
      image_url: existing.image_url,
      image_thumbnail_url: existing.image_thumbnail_url,
    },
    images: parsed,
    modifiedBy: resolvePlatformActor(req.superadminName ?? null),
  });
  if (isMemberImageRefusal(stored)) return { ok: false, status: stored.status, body: stored.body };
  recordAudit(req, {
    action: 'update', entityType: 'base_payment_method', entityId: existing.id,
    previous: { image_url: existing.image_url }, next: { image_url: stored.image_url },
  });
  return { ok: true, id: existing.id };
}

platformBasePaymentMethodsRouter.post('/', requireSuperadmin, async (req, res) => {
  const result = await createBasePaymentMethod(req, req.body ?? {});
  if (!result.ok) return res.status(result.status).json(result.body);
  res.status(201).json(await loadBasePaymentMethod(result.id, resolveLocale(req)));
});

platformBasePaymentMethodsRouter.put('/:id', requireSuperadmin, async (req, res) => {
  const body = req.body ?? {};
  if (body.status === undefined && body.translations === undefined && body.code === undefined) {
    return res.status(400).json({ error: 'At least one field must be provided' });
  }
  const locale = resolveLocale(req);
  const existing = await loadBasePaymentMethod(req.params.id, locale);
  if (!existing || existing.deleted_at) return res.status(404).json({ error: 'Payment method not found' });
  const result = await updateBasePaymentMethod(req, existing, body);
  if (!result.ok) return res.status(result.status).json(result.body);
  res.json(await loadBasePaymentMethod(existing.id, locale));
});

platformBasePaymentMethodsRouter.delete('/:id', requireSuperadmin, async (req, res) => {
  const existing = await loadBasePaymentMethod(req.params.id, resolveLocale(req));
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
  const row = await loadBasePaymentMethod(req.params.id, resolveLocale(req));
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
    const existing = await loadBasePaymentMethod(req.params.id, resolveLocale(req));
    if (!existing || existing.deleted_at) return res.status(404).json({ error: 'Payment method not found' });
    const result = await storeBasePaymentMethodImage(req, existing);
    if (!result.ok) return res.status(result.status).json(result.body);
    res.json(await loadBasePaymentMethod(existing.id, resolveLocale(req)));
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
    res.json(await loadBasePaymentMethod(loaded.row.id, resolveLocale(req)));
  } catch (err) { next(err); }
});
