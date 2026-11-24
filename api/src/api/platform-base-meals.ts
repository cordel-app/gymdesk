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
import { clearBaseMealImage, storeBaseMealImage } from './base-meal-image-storage';
import {
  isMemberImageRefusal,
  memberImageBodyParser,
  memberImageUploadRateLimit,
  parseMemberImageRequest,
} from './member-image-storage';
import { normalizeDescription } from '../domain/nutritionLibrary';
import { resolvePlatformActor } from '../domain/auditActor';

/**
 * #3328 stage 1 — Cordel → Base Meals, the only writer of `base_meals` (a
 * platform catalogue: no `gym_id`, so every route is `requireSuperadmin`).
 *
 * The name and description are the English base values; the other locales are
 * `base_meal_translations`, read and written through the goals' translation
 * module (kind `base_meal`), so the fallback, omit-keeps and `{}`-clears rules
 * are the same ones. The slug is generated once from the name and never
 * rewritten; the image is the server-made WebP pair under `cordel/meals/`.
 * Delete is soft. Nothing references a Base Meal yet (stage 2 links the
 * nutrition plans' meals to it and refuses deleting a referenced one).
 */
const TABLE = 'base_meals';
const KIND = 'base_meal' as const;
const entityType = 'base_meal';

const columnsFor = (locale: SupportedLocale) => `m.id, m.slug, m.name, m.description, m.position,
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

platformBaseMealsRouter.post('/', requireSuperadmin, async (req: AuditRequest, res, next) => {
  const body = req.body ?? {};
  const name = normalizeGoalName(body.name, { required: true });
  if ('error' in name) return res.status(400).json({ error: name.error });
  const description = normalizeDescription(body.description);
  if ('error' in description) return res.status(400).json({ error: description.error });
  const translations = parseGoalTranslations(body);
  if (translations.error) return res.status(400).json({ error: translations.error });
  try {
    const { rows: existing } = await db.query(
      `SELECT id FROM ${TABLE} WHERE name = ? AND deleted_at IS NULL`, [name.value],
    );
    if (existing.length > 0) return res.status(409).json(DUPLICATE_NAME);
    const actor = actorOf(req);
    const id = await db.transaction(async (tx) => {
      // #2951: generated once from the name, never rewritten by an edit.
      const slug = await allocateGlobalSlug('base_meals', name.value, tx);
      const { insertId } = await tx.query(
        `INSERT INTO ${TABLE} (slug, name, description, position, created_by)
         SELECT ?, ?, ?, COALESCE(MAX(position), 0) + 1, ? FROM ${TABLE}`,
        [slug, name.value, description.value ?? null, actor],
      );
      if (translations.translations) await replaceGoalTranslations(tx, insertId, translations.translations, KIND);
      return insertId as number;
    });
    const meal = await loadBaseMeal(id, getRequestLocale(req));
    recordAudit(req, { action: 'create', entityType, entityId: id, next: meal });
    res.status(201).json(meal);
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') return res.status(409).json(DUPLICATE_NAME);
    next(err);
  }
});

platformBaseMealsRouter.put('/:id', requireSuperadmin, async (req: AuditRequest, res, next) => {
  const id = String(req.params.id);
  const body = req.body ?? {};
  // The slug is the meal's stable identity (#2951): an update never reads it.
  const name = normalizeGoalName(body.name, { required: false });
  if ('error' in name) return res.status(400).json({ error: name.error });
  const description = normalizeDescription(body.description);
  if ('error' in description) return res.status(400).json({ error: description.error });
  const translations = parseGoalTranslations(body);
  if (translations.error) return res.status(400).json({ error: translations.error });
  try {
    const previous = await loadBaseMeal(id);
    if (!previous || previous.deleted_at) return res.status(404).json({ error: 'Meal not found' });
    if (name.value !== undefined) {
      const { rows: conflict } = await db.query(
        `SELECT id FROM ${TABLE} WHERE name = ? AND id != ? AND deleted_at IS NULL`, [name.value, id],
      );
      if (conflict.length > 0) return res.status(409).json(DUPLICATE_NAME);
    }
    const updates = ['modified_at = UTC_TIMESTAMP()', 'modified_by = ?'];
    const params: unknown[] = [actorOf(req)];
    if (name.value !== undefined) { updates.push('name = ?'); params.push(name.value); }
    if (description.value !== undefined) { updates.push('description = ?'); params.push(description.value); }
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE ${TABLE} SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
      if (translations.translations) await replaceGoalTranslations(tx, id, translations.translations, KIND);
    });
    const meal = await loadBaseMeal(id, getRequestLocale(req));
    recordAudit(req, { action: 'update', entityType, entityId: id, previous, next: meal });
    res.json(meal);
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') return res.status(409).json(DUPLICATE_NAME);
    next(err);
  }
});

platformBaseMealsRouter.delete('/:id', requireSuperadmin, async (req: AuditRequest, res, next) => {
  const id = String(req.params.id);
  try {
    const previous = await loadBaseMeal(id);
    if (!previous || previous.deleted_at) return res.status(404).json({ error: 'Meal not found' });
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

async function loadForImage(id: string) {
  const { rows } = await db.query<any>(
    `SELECT id, slug, deleted_at, image_url, image_thumbnail_url FROM ${TABLE} WHERE id = ?`, [id],
  );
  const row = rows[0];
  if (!row || row.deleted_at) return null;
  return { id: Number(row.id), slug: row.slug as string, image_url: row.image_url, image_thumbnail_url: row.image_thumbnail_url };
}

platformBaseMealsRouter.post(
  '/:id/image', requireSuperadmin, memberImageUploadRateLimit, memberImageBodyParser,
  async (req: AuditRequest, res, next) => {
    try {
      const meal = await loadForImage(String(req.params.id));
      if (!meal) return res.status(404).json({ error: 'Meal not found' });
      const parsed = await parseMemberImageRequest(req);
      if (isMemberImageRefusal(parsed)) return res.status(parsed.status).json(parsed.body);
      const stored = await storeBaseMealImage({ meal, images: parsed, modifiedBy: actorOf(req) });
      if (isMemberImageRefusal(stored)) return res.status(stored.status).json(stored.body);
      recordAudit(req, {
        action: 'update', entityType, entityId: meal.id,
        previous: { image_url: meal.image_url }, next: { image_url: stored.image_url },
      });
      res.json(await loadBaseMeal(meal.id, getRequestLocale(req)));
    } catch (err) { next(err); }
  },
);

platformBaseMealsRouter.delete('/:id/image', requireSuperadmin, async (req: AuditRequest, res, next) => {
  try {
    const meal = await loadForImage(String(req.params.id));
    if (!meal) return res.status(404).json({ error: 'Meal not found' });
    await clearBaseMealImage({ meal, modifiedBy: actorOf(req) });
    recordAudit(req, {
      action: 'update', entityType, entityId: meal.id,
      previous: { image_url: meal.image_url }, next: { image_url: null },
    });
    res.json(await loadBaseMeal(meal.id, getRequestLocale(req)));
  } catch (err) { next(err); }
});
