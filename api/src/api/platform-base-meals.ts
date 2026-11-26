import { Request, Router } from 'express';
import { db } from '../infra/db';
import { allocateGlobalSlug } from './entity-slugs';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { normalizeGoalName } from '../domain/goalLibrary';
import { BASE_LOCALE, SUPPORTED_LOCALES, TRANSLATABLE_LOCALES, getRequestLocale, SupportedLocale } from '../infra/locale';
import {
  goalTranslatedSearchSql,
  goalTranslationsExpr,
  localizedGoalExprs,
  parseGoalTranslations,
  replaceGoalTranslations,
  withGoalTranslations,
} from '../domain/nutritionGoalTranslations';
import { countBaseMealReferences } from './base-meal-reference';
import { BaseMealImageRow, clearBaseMealImage, storeBaseMealImage } from './base-meal-image-storage';
import {
  isMemberImageRefusal,
  memberImageBodyParser,
  memberImageUploadRateLimit,
  parseMemberImageRequest,
} from './member-image-storage';
import { normalizeDescription } from '../domain/nutritionLibrary';
import { resolvePlatformActor } from '../domain/auditActor';
import { BASE_MEAL_STATUSES, parseBaseMealStatusInput } from '../domain/baseMeals';

/**
 * #3328 stage 1 — Cordel → Base Meals, the only writer of `base_meals` (a
 * platform catalogue: no `gym_id`, so every route is `requireSuperadmin`).
 *
 * The name and description are the English base values; the other locales are
 * `base_meal_translations`, read and written through the goals' translation
 * module (kind `base_meal`), so the fallback, omit-keeps and `{}`-clears rules
 * are the same ones. The slug is generated once from the name and never
 * rewritten; the image is the server-made WebP pair under `cordel/meals/`.
 * Delete is soft and refused (409 `base_meal_in_use`) while a nutrition plan's
 * or template's meal references the meal (#3328 stage 2).
 */
const TABLE = 'base_meals';
const KIND = 'base_meal' as const;
const entityType = 'base_meal';

const columnsFor = (locale: SupportedLocale) => `m.id, m.slug, m.name, m.description, m.position, m.status,
    m.image_url, m.image_thumbnail_url,
    ${localizedGoalExprs('m', locale, KIND)}, ${goalTranslationsExpr('m', 'translations', KIND)},
    m.created_at, m.created_by, m.modified_at, m.modified_by, m.deleted_at, m.deleted_by`;

const shape = <T extends Record<string, any>>(row: T) => withGoalTranslations(row as any) as T;
type AuditRequest = Request & { superadminName?: string | null };
const actorOf = (req: AuditRequest) => resolvePlatformActor(req.superadminName ?? null);

export async function loadBaseMeal(id: unknown, locale: SupportedLocale = BASE_LOCALE) {
  const { rows } = await db.query(`SELECT ${columnsFor(locale)} FROM ${TABLE} m WHERE m.id = ?`, [id]);
  return rows[0] ? shape(rows[0]) : undefined;
}

const DUPLICATE_NAME = { error: 'A meal with this name already exists' };

export const platformBaseMealsRouter = Router();

platformBaseMealsRouter.get('/locales', requireSuperadmin, (_req, res) => {
  res.json({ locales: SUPPORTED_LOCALES, base_locale: BASE_LOCALE, translatable: TRANSLATABLE_LOCALES });
});

platformBaseMealsRouter.get('/', requireSuperadmin, async (req, res, next) => {
  const where = ['m.deleted_at IS NULL'];
  const params: unknown[] = [];
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  if (status) {
    // #3328 stage 3: a closed set, so an unknown value is refused rather than matching nothing.
    if (!(BASE_MEAL_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${BASE_MEAL_STATUSES.join(', ')}` });
    }
    where.push('m.status = ?');
    params.push(status);
  }
  const term = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (term) {
    where.push(goalTranslatedSearchSql('m', KIND));
    params.push(`%${term}%`, `%${term}%`, `%${term}%`);
  }
  try {
    const { rows } = await db.query(
      `SELECT ${columnsFor(getRequestLocale(req))} FROM ${TABLE} m WHERE ${where.join(' AND ')}
        ORDER BY m.position ASC, m.name ASC, m.id ASC`,
      params,
    );
    res.json(rows.map(shape));
  } catch (err) { next(err); }
});

platformBaseMealsRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const meal = await loadBaseMeal(String(req.params.id), getRequestLocale(req));
    if (!meal || meal.deleted_at) return res.status(404).json({ error: 'Meal not found' });
    res.json(meal);
  } catch (err) { next(err); }
});

export type BaseMealWriteResult =
  | { ok: true; id: number }
  | { ok: false; status: number; body: Record<string, unknown> };

const refuse = (status: number, body: Record<string, unknown>): BaseMealWriteResult => ({ ok: false, status, body });

/**
 * Creates a Base Meal (the editor's `POST /` and #2952's import both write
 * through this). `opts.slug` is the import's: an archive's meal keeps the slug
 * it was exported with; otherwise the slug is generated once from the name.
 */
export async function createBaseMeal(
  req: AuditRequest,
  body: Record<string, any>,
  opts: { slug?: string } = {},
): Promise<BaseMealWriteResult> {
  const name = normalizeGoalName(body?.name, { required: true });
  if ('error' in name) return refuse(400, { error: name.error });
  const description = normalizeDescription(body?.description);
  if ('error' in description) return refuse(400, { error: description.error });
  const translations = parseGoalTranslations(body ?? {});
  if (translations.error) return refuse(400, { error: translations.error });
  const status = parseBaseMealStatusInput(body);
  if ('error' in status) return refuse(400, { error: status.error });
  try {
    const { rows: existing } = await db.query(
      `SELECT id FROM ${TABLE} WHERE name = ? AND deleted_at IS NULL`, [name.value],
    );
    if (existing.length > 0) return refuse(409, DUPLICATE_NAME);
    const actor = actorOf(req);
    const id = await db.transaction(async (tx) => {
      // #2951: generated once from the name, never rewritten by an edit.
      const slug = opts.slug ?? await allocateGlobalSlug('base_meals', name.value, tx);
      const { insertId } = await tx.query(
        `INSERT INTO ${TABLE} (slug, name, description, position, status, created_by)
         SELECT ?, ?, ?, COALESCE(MAX(position), 0) + 1, ?, ? FROM ${TABLE}`,
        [slug, name.value, description.value ?? null, status.value ?? 'active', actor],
      );
      if (translations.translations) await replaceGoalTranslations(tx, insertId, translations.translations, KIND);
      return insertId as number;
    });
    const meal = await loadBaseMeal(id, getRequestLocale(req));
    recordAudit(req, { action: 'create', entityType, entityId: id, next: meal });
    return { ok: true, id };
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') return refuse(409, DUPLICATE_NAME);
    throw err;
  }
}

/**
 * Writes a Base Meal's own content; a field the body does not name keeps what is
 * stored. The slug is the meal's stable identity (#2951): an update never reads it.
 */
export async function updateBaseMeal(
  req: AuditRequest,
  mealId: number | string,
  body: Record<string, any>,
): Promise<BaseMealWriteResult> {
  const id = String(mealId);
  const name = normalizeGoalName(body?.name, { required: false });
  if ('error' in name) return refuse(400, { error: name.error });
  const description = normalizeDescription(body?.description);
  if ('error' in description) return refuse(400, { error: description.error });
  const translations = parseGoalTranslations(body ?? {});
  if (translations.error) return refuse(400, { error: translations.error });
  const status = parseBaseMealStatusInput(body);
  if ('error' in status) return refuse(400, { error: status.error });
  try {
    const previous = await loadBaseMeal(id);
    if (!previous || previous.deleted_at) return refuse(404, { error: 'Meal not found' });
    if (name.value !== undefined) {
      const { rows: conflict } = await db.query(
        `SELECT id FROM ${TABLE} WHERE name = ? AND id != ? AND deleted_at IS NULL`, [name.value, id],
      );
      if (conflict.length > 0) return refuse(409, DUPLICATE_NAME);
    }
    const updates = ['modified_at = UTC_TIMESTAMP()', 'modified_by = ?'];
    const params: unknown[] = [actorOf(req)];
    if (name.value !== undefined) { updates.push('name = ?'); params.push(name.value); }
    if (description.value !== undefined) { updates.push('description = ?'); params.push(description.value); }
    if (status.value !== undefined) { updates.push('status = ?'); params.push(status.value); }
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE ${TABLE} SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
      if (translations.translations) await replaceGoalTranslations(tx, id, translations.translations, KIND);
    });
    const meal = await loadBaseMeal(id, getRequestLocale(req));
    recordAudit(req, { action: 'update', entityType, entityId: id, previous, next: meal });
    return { ok: true, id: Number(id) };
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') return refuse(409, DUPLICATE_NAME);
    throw err;
  }
}

platformBaseMealsRouter.post('/', requireSuperadmin, async (req: AuditRequest, res, next) => {
  try {
    const result = await createBaseMeal(req, req.body ?? {});
    if (!result.ok) return res.status(result.status).json(result.body);
    res.status(201).json(await loadBaseMeal(result.id, getRequestLocale(req)));
  } catch (err) { next(err); }
});

platformBaseMealsRouter.put('/:id', requireSuperadmin, async (req: AuditRequest, res, next) => {
  try {
    const result = await updateBaseMeal(req, String(req.params.id), req.body ?? {});
    if (!result.ok) return res.status(result.status).json(result.body);
    res.json(await loadBaseMeal(result.id, getRequestLocale(req)));
  } catch (err) { next(err); }
});

platformBaseMealsRouter.delete('/:id', requireSuperadmin, async (req: AuditRequest, res, next) => {
  const id = String(req.params.id);
  try {
    const previous = await loadBaseMeal(id);
    if (!previous || previous.deleted_at) return res.status(404).json({ error: 'Meal not found' });
    // #3328 stage 2: a meal a nutrition plan or template still uses is not deleted.
    const references = await countBaseMealReferences(id);
    if (references > 0) {
      return res.status(409).json({
        error: 'This meal is used by nutrition plans and cannot be deleted',
        code: 'base_meal_in_use',
        references,
      });
    }
    await db.query(
      `UPDATE ${TABLE} SET deleted_at = UTC_TIMESTAMP(), deleted_by = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [actorOf(req), actorOf(req), id],
    );
    recordAudit(req, { action: 'delete', entityType, entityId: id, previous });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Image: WebP 1080 × 1080 master + 256 × 256 thumbnail under `cordel/meals/` ── */

export async function loadBaseMealForImage(id: string): Promise<BaseMealImageRow | null> {
  const { rows } = await db.query<any>(
    `SELECT id, slug, deleted_at, image_url, image_thumbnail_url FROM ${TABLE} WHERE id = ?`, [id],
  );
  const row = rows[0];
  if (!row || row.deleted_at) return null;
  return { id: Number(row.id), slug: row.slug as string, image_url: row.image_url, image_thumbnail_url: row.image_thumbnail_url };
}

/**
 * Processes the request's picture and stores it as the meal's image (the
 * editor's upload and #2952's import both write through this).
 */
export async function storeBaseMealImageFromRequest(
  req: AuditRequest,
  meal: BaseMealImageRow,
): Promise<BaseMealWriteResult> {
  const parsed = await parseMemberImageRequest(req);
  if (isMemberImageRefusal(parsed)) return refuse(parsed.status, parsed.body);
  const stored = await storeBaseMealImage({ meal, images: parsed, modifiedBy: actorOf(req) });
  if (isMemberImageRefusal(stored)) return refuse(stored.status, stored.body);
  recordAudit(req, {
    action: 'update', entityType, entityId: meal.id,
    previous: { image_url: meal.image_url }, next: { image_url: stored.image_url },
  });
  return { ok: true, id: meal.id };
}

platformBaseMealsRouter.post(
  '/:id/image', requireSuperadmin, memberImageUploadRateLimit, memberImageBodyParser,
  async (req: AuditRequest, res, next) => {
    try {
      const meal = await loadBaseMealForImage(String(req.params.id));
      if (!meal) return res.status(404).json({ error: 'Meal not found' });
      const result = await storeBaseMealImageFromRequest(req, meal);
      if (!result.ok) return res.status(result.status).json(result.body);
      res.json(await loadBaseMeal(meal.id, getRequestLocale(req)));
    } catch (err) { next(err); }
  },
);

platformBaseMealsRouter.delete('/:id/image', requireSuperadmin, async (req: AuditRequest, res, next) => {
  try {
    const meal = await loadBaseMealForImage(String(req.params.id));
    if (!meal) return res.status(404).json({ error: 'Meal not found' });
    await clearBaseMealImage({ meal, modifiedBy: actorOf(req) });
    recordAudit(req, {
      action: 'update', entityType, entityId: meal.id,
      previous: { image_url: meal.image_url }, next: { image_url: null },
    });
    res.json(await loadBaseMeal(meal.id, getRequestLocale(req)));
  } catch (err) { next(err); }
});
