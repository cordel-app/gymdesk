import { parseExerciseCategoryInput } from '../domain/exerciseCategories';
import { assertRequestedResultTypesMatch, effectiveCategory, syncExerciseResultTypes } from './exercise-result-types';
import { Request, Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { withGenderMediaCompanions } from '../domain/exerciseGenderMedia';
import { createExerciseGenderMediaRouter } from './exercise-gender-media';
import {
  exerciseNameSearchSql,
  exerciseTranslationsExpr,
  localizedExerciseNameExpr,
  localizedExerciseNameSql,
  parseExerciseTranslations,
  replaceExerciseTranslations,
  withExerciseTranslations,
} from '../domain/exerciseTranslations';
import {
  copyExerciseDescriptionTranslations,
  descriptionTranslationsExpr,
  localizedDescriptionExprs,
  parseDescriptionTranslations,
  parseShortDescription,
  replaceExerciseDescriptionTranslations,
  withDescriptionTranslations,
} from '../domain/exerciseDescriptionTranslations';
import {
  BASE_LOCALE,
  SUPPORTED_LOCALES,
  TRANSLATABLE_LOCALES,
  getRequestLocale,
} from '../infra/locale';
import { normalizeMuscleKey } from '../domain/muscles';
import { primaryMuscleImagesSql, withEffectiveImage } from '../domain/effectiveExerciseImage';
import { MUSCLE_SLUG_SQL, insertExerciseMuscle, listMuscles } from './exercise-muscles';
import {
  exerciseFacetsQuery,
  exerciseListFilterSql,
  groupExerciseFacets,
  parseExerciseListFilter,
} from '../domain/exerciseListFilters';
import { resolvePlatformActor } from '../domain/auditActor';
import { BASE_EXERCISE_TABLES as B } from '../domain/exerciseTables';
import { mirrorExerciseToLegacy, reserveBaseExerciseId } from './exercise-base-mirror';

export const platformExercisesRouter = Router();

const SETTABLE_STATUSES = ['active', 'inactive'];

/**
 * The actor text to stamp on a write (#965, #1182).
 *
 * Every write on this router is a superadmin's, by `requireSuperadmin`; the
 * actor is their own name, snapshotted as plain text.
 */
function platformActor(req: { superadminName?: string | null }) {
  return resolvePlatformActor(req.superadminName);
}

/**
 * #967: a Base Exercise carries the same two name fields a gym's own does —
 * `name` is the base value the editor submits back, `display_name` the caller's
 * language resolved from `exercise_translations`. One contract for both kinds of
 * exercise (§8), so nothing downstream branches on where the row came from.
 */
const selectFor = (locale: Parameters<typeof localizedExerciseNameExpr>[1]) => `
  SELECT e.*, NULL AS gym_id, NULL AS cloned_from_id,
    ${localizedExerciseNameExpr('e', locale, 'display_name', B)},
    ${exerciseTranslationsExpr('e', 'translations', B)},
    ${localizedDescriptionExprs('e', locale, B)},
    ${descriptionTranslationsExpr('e', 'description_translations', B)},
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('key', ${MUSCLE_SLUG_SQL}, 'role', em.role))
     FROM ${B.muscles} em WHERE em.exercise_id = e.id) AS muscles,
    ${primaryMuscleImagesSql('e', B)},
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', rt.id, 'name', rt.name, 'slug', rt.slug))
     FROM ${B.resultTypes} eart
     JOIN result_types rt ON rt.id = eart.result_type_id
     WHERE eart.exercise_id = e.id ORDER BY rt.id) AS allowed_result_types
  FROM ${B.exercises} e
`;

/** A read row as the caller gets it: translations map plus the effective image (#1368 stage 4). */
const shapeExercise = (row: any) => withGenderMediaCompanions(withEffectiveImage(withDescriptionTranslations(withExerciseTranslations(row))));

const selectForReq = (req: Request) => selectFor(getRequestLocale(req));

function parseMuscles(input: unknown): { key: string; role: 'principal' | 'secondary' }[] | string | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) return 'muscles must be an array of { key, role }';
  const seen = new Set<string>();
  const parsed: { key: string; role: 'principal' | 'secondary' }[] = [];
  for (const m of input) {
    const key = normalizeMuscleKey(m?.key);
    if (!key) return `invalid muscle key: ${JSON.stringify(m?.key)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ key, role: m.role === 'secondary' ? 'secondary' : 'principal' });
  }
  return parsed;
}

async function nameTaken(name: string, excludeId?: string | number): Promise<boolean> {
  let sql = `SELECT id FROM ${B.exercises} WHERE name = ? AND status != 'deleted'`;
  const params: any[] = [name];
  if (excludeId !== undefined) { sql += ' AND id != ?'; params.push(excludeId); }
  const { rows } = await db.query(sql, params);
  return rows.length > 0;
}

/* ── List ─────────────────────────────────────────────────────────────────── */

/** The rows this router owns: the platform's own, minus the soft-deleted. */
const BASE_SCOPE_SQL = "e.status != 'deleted'";

/**
 * #964 §18, extended by #969: the Base Exercises catalogue is ~900 rows after
 * the Free Exercise DB import, so every filter the list offers is applied
 * **here** rather than in the browser (§16/§17) — the rule `GET /exercises/base`
 * already follows for the Import modal.
 *
 * The vocabulary and the SQL are `domain/exerciseListFilters.ts`, which is what
 * makes this screen, the Import modal and a gym's own Exercises page "the same
 * filtering UX" (§19) rather than three readings of `?muscle=`. What this route
 * adds is the scope — `gym_id IS NULL` — and the ordering, which follows the
 * *displayed* name because that is what the page shows (#967, #643).
 *
 * There is deliberately **no pagination**: the thread's `Q3` answer is "do not
 * paginate, display all", so §14's count is the whole of §14/§15 and the
 * response shape stays the array every caller already reads.
 */
platformExercisesRouter.get('/', requireSuperadmin, async (req, res, next) => {
  const parsed = parseExerciseListFilter(req.query as Record<string, unknown>);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const locale = getRequestLocale(req);
  const where = exerciseListFilterSql('e', parsed.filter, B);
  const sql = `${selectFor(locale)} WHERE ${BASE_SCOPE_SQL}${where.sql}`
    + ` ORDER BY ${localizedExerciseNameSql('e', locale, B)} ASC`;
  try {
    const { rows } = await db.query(sql, where.params);
    res.json(rows.map(shapeExercise));
  } catch (err) { next(err); }
});

/**
 * What the inline filter toolbar's dropdowns offer, plus the unfiltered total
 * `Showing 42 of 612` counts against (#969 §8, §9, §14).
 *
 * The options are the values **present** in the catalogue, never a declared
 * list: `equipment`, `category`, `level` and `mechanic` are free text preserved
 * verbatim from the Free Exercise DB (#964 §7, §11), so declaring their values
 * here would be inventing the taxonomy §8 forbids — and a facet that comes back
 * empty is a control the page does not render at all (§9).
 *
 * Registered **before** `/:id`, or Express reads `facets` as an exercise id.
 */
platformExercisesRouter.get('/facets', requireSuperadmin, async (_req, res, next) => {
  try {
    const facetQuery = exerciseFacetsQuery(BASE_SCOPE_SQL, [], B);
    const [facets, totals] = await Promise.all([
      db.query(facetQuery.sql, facetQuery.params),
      db.query(`SELECT COUNT(*) AS total FROM ${B.exercises} e WHERE ${BASE_SCOPE_SQL}`),
    ]);
    res.json({
      total: Number(totals.rows[0]?.total ?? 0),
      ...groupExerciseFacets(facets.rows as { facet: string; value: string }[]),
    });
  } catch (err) { next(err); }
});

/* ── Catalogues the Base Exercise editor needs (#806) ─────────────────────── */
//
// The shared Exercise editor (`components/exercises/ExerciseEditor.tsx`) renders
// Muscles and Allowed Result Types on both screens, so the Base Exercises page
// needs the same two catalogues the gym-facing page reads from `/muscles` and
// `/result-types`. Those two sit behind `tenantContext` +
// `requireModuleAccess('TRAINING')` + `requireFeatureEnabled('training.exercises')`
// (app.ts), which is right for a gym screen and wrong here: a platform screen
// must not stop working because the superadmin's *currently selected* gym has the
// exercises feature switched off, and a base exercise belongs to no gym at all.
//
// Neither catalogue is gym-scoped — `MUSCLE_KEYS` is a fixed list in
// `domain/muscles.ts` and `result_types` is the seeded, gym-less table of
// migration 073 — so this is the same data, read under this router's own
// `requireSuperadmin`. No endpoint is merged (#806 §6): the gym-facing routes are
// untouched and keep answering for gym screens.
//
// Registered **before** `/:id`, or Express would match `lookups` as an exercise id.

platformExercisesRouter.get('/lookups', requireSuperadmin, async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, name, slug FROM result_types ORDER BY id ASC');
    res.json({
      muscles: (await listMuscles()).map(({ key }) => ({ key })),
      result_types: rows,
      // #967 §3: the shared editor renders one Name input per translatable
      // locale, so the language list travels with the other two catalogues
      // rather than being hardcoded in the page (the ticket's closing
      // "Important"). The gym-facing page has no lookups endpoint and reads
      // `GET /exercises/locales` for the same payload.
      locales: SUPPORTED_LOCALES,
      base_locale: BASE_LOCALE,
      translatable: TRANSLATABLE_LOCALES,
    });
  } catch (err) { next(err); }
});

/* ── Get one ──────────────────────────────────────────────────────────────── */

platformExercisesRouter.get('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `${selectForReq(req)} WHERE e.id = ? AND e.status != 'deleted'`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Exercise not found' });
    res.json(shapeExercise(rows[0]));
  } catch (err) { next(err); }
});

/* ── Create ───────────────────────────────────────────────────────────────── */

platformExercisesRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const {
    name, description,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, status,
  } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const muscles = parseMuscles(req.body.muscles);
  if (typeof muscles === 'string') return res.status(400).json({ error: muscles });
  const categoryInput = parseExerciseCategoryInput(req.body);
  if (categoryInput.error) return res.status(400).json({ error: categoryInput.error });
  const allowedResultTypeIds: number[] | undefined =
    Array.isArray(req.body.allowed_result_type_ids) ? req.body.allowed_result_type_ids.map(Number) : undefined;
  // #967: the same `translations` contract the gym-facing router takes — one
  // mechanism for both kinds of exercise (§8, §10).
  const { translations, error: translationsError } = parseExerciseTranslations(req.body);
  if (translationsError) return res.status(400).json({ error: translationsError });
  // #1419: the description in every other language, and the base short one.
  const { descriptionTranslations, error: descTranslationsError } = parseDescriptionTranslations(req.body);
  if (descTranslationsError) return res.status(400).json({ error: descTranslationsError });
  const shortDescription = parseShortDescription(req.body);
  if (shortDescription.error) return res.status(400).json({ error: shortDescription.error });
  const actor = platformActor(req);
  try {
    if (await nameTaken(name.trim())) {
      return res.status(409).json({ error: 'A base exercise with this name already exists.' });
    }
    const insertId = await db.transaction(async (tx) => {
      const newId = await reserveBaseExerciseId(tx);
      await tx.query(
        `INSERT INTO ${B.exercises}
          (id, name, description, short_description, category,
           min_reps_default, max_reps_default, rest_default_seconds, sets_default, status,
           created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId, name.trim(), description ?? null, shortDescription.value, categoryInput.value,
         min_reps_default ?? null, max_reps_default ?? null, rest_default_seconds ?? null,
         sets_default ?? null, status ?? 'active',
         actor],
      );
      if (muscles) {
        for (const m of muscles) {
          await insertExerciseMuscle(tx, null, newId, m.key, m.role, { tables: B });
        }
      }
      await assertRequestedResultTypesMatch(tx, categoryInput.value, allowedResultTypeIds);
      await syncExerciseResultTypes(tx, newId, categoryInput.value, B);
      if (translations) await replaceExerciseTranslations(tx, newId, translations, B);
      if (descriptionTranslations) await replaceExerciseDescriptionTranslations(tx, newId, descriptionTranslations, B);
      await mirrorExerciseToLegacy(tx, newId);
      return newId;
    });
    const { rows } = await db.query(`${selectForReq(req)} WHERE e.id = ?`, [insertId]);
    const created = shapeExercise(rows[0]);
    recordAudit(req, { action: 'create', entityType: 'exercise', entityId: insertId, next: created });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

/* ── Update ───────────────────────────────────────────────────────────────── */

platformExercisesRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  const id = String(req.params.id);
  const {
    name, description,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, status,
  } = req.body;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const muscles = parseMuscles(req.body.muscles);
  if (typeof muscles === 'string') return res.status(400).json({ error: muscles });
  const categoryInput = parseExerciseCategoryInput(req.body);
  if (categoryInput.error) return res.status(400).json({ error: categoryInput.error });
  const allowedResultTypeIds: number[] | undefined =
    Array.isArray(req.body.allowed_result_type_ids) ? req.body.allowed_result_type_ids.map(Number) : undefined;
  // #967: replace-all when the field is sent, untouched when it is not — the
  // gym-side rule, for the same reason (a client editing another field must not
  // clear the catalogue's translations).
  const { translations, error: translationsError } = parseExerciseTranslations(req.body);
  if (translationsError) return res.status(400).json({ error: translationsError });
  // #1419: the description in every other language, and the base short one.
  const { descriptionTranslations, error: descTranslationsError } = parseDescriptionTranslations(req.body);
  if (descTranslationsError) return res.status(400).json({ error: descTranslationsError });
  const shortDescription = parseShortDescription(req.body);
  if (shortDescription.error) return res.status(400).json({ error: shortDescription.error });
  const actor = platformActor(req);
  try {
    const { rows: existing } = await db.query(
      `SELECT id FROM ${B.exercises} WHERE id = ? AND status != 'deleted'`,
      [id],
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Exercise not found' });
    if (name?.trim() && await nameTaken(name.trim(), id)) {
      return res.status(409).json({ error: 'A base exercise with this name already exists.' });
    }
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE ${B.exercises} SET
          name                  = COALESCE(?, name),
          description           = IF(?, ?, description),
          short_description     = IF(?, ?, short_description),
          min_reps_default      = IF(?, ?, min_reps_default),
          max_reps_default      = IF(?, ?, max_reps_default),
          rest_default_seconds  = IF(?, ?, rest_default_seconds),
          sets_default          = IF(?, ?, sets_default),
          category              = IF(?, ?, category),
          status                = COALESCE(?, status),
          modified_at           = UTC_TIMESTAMP(),
          -- #1182: who last changed it, snapshotted beside when.
          modified_by           = ?
         WHERE id = ? AND status != 'deleted'`,
        [
          name?.trim() ?? null,
          'description' in req.body ? 1 : 0, description ?? null,
          shortDescription.provided ? 1 : 0, shortDescription.value,
          'min_reps_default' in req.body ? 1 : 0, min_reps_default ?? null,
          'max_reps_default' in req.body ? 1 : 0, max_reps_default ?? null,
          'rest_default_seconds' in req.body ? 1 : 0, rest_default_seconds ?? null,
          'sets_default' in req.body ? 1 : 0, sets_default ?? null,
          categoryInput.provided ? 1 : 0, categoryInput.value,
          status ?? null,
          actor,
          id,
        ],
      );
      if (muscles) {
        await tx.query(`DELETE FROM ${B.muscles} WHERE exercise_id = ?`, [id]);
        for (const m of muscles) {
          await insertExerciseMuscle(tx, null, id, m.key, m.role, { tables: B });
        }
      }
      const category = await effectiveCategory(tx, id, categoryInput, B);
      await assertRequestedResultTypesMatch(tx, category, allowedResultTypeIds);
      if (categoryInput.provided) await syncExerciseResultTypes(tx, id, category, B);
      if (translations) await replaceExerciseTranslations(tx, id, translations, B);
      if (descriptionTranslations) await replaceExerciseDescriptionTranslations(tx, id, descriptionTranslations, B);
      await mirrorExerciseToLegacy(tx, id);
    });
    const { rows } = await db.query(`${selectForReq(req)} WHERE e.id = ?`, [id]);
    const updated = shapeExercise(rows[0]);
    recordAudit(req, { action: 'update', entityType: 'exercise', entityId: id, next: updated });
    res.json(updated);
  } catch (err) { next(err); }
});

/* The Base Exercise media routes (`POST`/`DELETE /:id/(image|video)/:gender`) live in
 * `exercise-gender-media.ts` and are registered at the end of this file (#1420). */

/* ── Soft delete ──────────────────────────────────────────────────────────── */

platformExercisesRouter.delete('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const deleted = await db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE ${B.exercises} SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by = ? WHERE id = ? AND status != 'deleted'`,
        [platformActor(req), req.params.id],
      );
      if ((rowCount ?? 0) === 0) return false;
      await mirrorExerciseToLegacy(tx, String(req.params.id));
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'Exercise not found' });
    recordAudit(req, { action: 'delete', entityType: 'exercise', entityId: req.params.id });
    res.status(204).send();
  } catch (err) { next(err); }
});

/* ── Base Exercise gender-specific media (#1420) ──────────────────────────── */
//
// The platform half of `exercise-gender-media.ts`: the same four references,
// stored under `cordel/exercises/`. Registered last so `DELETE /:id` above never
// shadows the two-segment paths (they differ in depth, so this is belt and braces).
platformExercisesRouter.use(createExerciseGenderMediaRouter({
  scope: 'platform',
  guard: requireSuperadmin,
  respond: async (req, res, id) => {
    const { rows } = await db.query(`${selectForReq(req)} WHERE e.id = ?`, [id]);
    res.json(shapeExercise(rows[0]));
  },
}));
