import { parseExerciseEquipmentInput } from '../domain/exerciseEquipment';
import { parseExerciseCategoryInput } from '../domain/exerciseCategories';
import { applyRecordedMetrics, parseRecordedMetricsRequest, respondMetricRemoval, syncExerciseResultTypes } from './exercise-result-types';
import { Request, Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { withGenderMediaCompanions } from '../domain/exerciseGenderMedia';
import { createExerciseGenderMedia } from './exercise-gender-media';
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
import { reserveBaseExerciseId } from './base-exercise-ids';
import { allocateBaseExerciseSlug } from './entity-slugs';

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

platformExercisesRouter.get('/lookups', requireSuperadmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT id, name, slug FROM result_types ORDER BY id ASC');
    res.json({
      muscles: (await listMuscles(getRequestLocale(req))).map(({ key, display_name }) => ({ key, display_name })),
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

/** What a Base Exercise writer answers: the row's id, or the refusal the route sends as is. */
export type BaseExerciseWriteResult =
  | { ok: true; id: number | string }
  | { ok: false; status: number; body: Record<string, unknown> };

const refuse = (status: number, error: string): BaseExerciseWriteResult => ({ ok: false, status, body: { error } });

/** Reads one Base Exercise as this router shapes it, in the request's locale. */
export async function loadBaseExercise(req: Request, id: number | string) {
  const { rows } = await db.query(`${selectForReq(req)} WHERE e.id = ?`, [id]);
  return rows[0] ? shapeExercise(rows[0]) : null;
}

/**
 * Creates a Base Exercise (`POST /platform/exercises`, and an import of a slug no
 * row carries, #2952). `opts.slug` is the slug an import carries (#2951's "never
 * regenerated", across databases); without it the slug is allocated from the name.
 */
export async function createBaseExercise(
  req: Request,
  body: Record<string, any>,
  opts: { slug?: string } = {},
): Promise<BaseExerciseWriteResult> {
  const {
    name, description,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, status,
  } = body;
  if (typeof name !== 'string' || !name.trim()) return refuse(400, 'name is required');
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return refuse(400, `status must be one of: ${SETTABLE_STATUSES.join(', ')}`);
  }
  const muscles = parseMuscles(body.muscles);
  if (typeof muscles === 'string') return refuse(400, muscles);
  const categoryInput = parseExerciseCategoryInput(body);
  if (categoryInput.error) return refuse(400, categoryInput.error);
  const equipmentInput = parseExerciseEquipmentInput(body);
  if (equipmentInput.error) return refuse(400, equipmentInput.error);
  let metricsRequest;
  try { metricsRequest = parseRecordedMetricsRequest(body); }
  catch (e: any) { return refuse(e.status ?? 400, e.message); }
  // #967: the same `translations` contract the gym-facing router takes — one
  // mechanism for both kinds of exercise (§8, §10).
  const { translations, error: translationsError } = parseExerciseTranslations(body);
  if (translationsError) return refuse(400, translationsError);
  // #1419: the description in every other language, and the base short one.
  const { descriptionTranslations, error: descTranslationsError } = parseDescriptionTranslations(body);
  if (descTranslationsError) return refuse(400, descTranslationsError);
  const shortDescription = parseShortDescription(body);
  if (shortDescription.error) return refuse(400, shortDescription.error);
  const actor = platformActor(req);
  if (await nameTaken(name.trim())) {
    return refuse(409, 'A base exercise with this name already exists.');
  }
  const insertId = await db.transaction(async (tx) => {
    const newId = await reserveBaseExerciseId(tx);
    const slug = opts.slug ?? await allocateBaseExerciseSlug(name.trim(), tx);
    await tx.query(
      `INSERT INTO ${B.exercises}
        (id, name, slug, description, short_description, category, equipment,
         min_reps_default, max_reps_default, rest_default_seconds, sets_default, status,
         created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, name.trim(), slug, description ?? null, shortDescription.value, categoryInput.value, equipmentInput.value,
       min_reps_default ?? null, max_reps_default ?? null, rest_default_seconds ?? null,
       sets_default ?? null, status ?? 'active',
       actor],
    );
    if (muscles) {
      for (const m of muscles) {
        await insertExerciseMuscle(tx, null, newId, m.key, m.role, { tables: B });
      }
    }
    if (metricsRequest.ids) await applyRecordedMetrics(tx, newId, null, metricsRequest, B);
    else await syncExerciseResultTypes(tx, newId, categoryInput.value, B);
    if (translations) await replaceExerciseTranslations(tx, newId, translations, B);
    if (descriptionTranslations) await replaceExerciseDescriptionTranslations(tx, newId, descriptionTranslations, B);
    return newId;
  });
  recordAudit(req, { action: 'create', entityType: 'exercise', entityId: insertId, next: await loadBaseExercise(req, insertId) });
  return { ok: true, id: insertId };
}

platformExercisesRouter.post('/', requireSuperadmin, async (req, res, next) => {
  try {
    const result = await createBaseExercise(req, req.body ?? {});
    if (!result.ok) return res.status(result.status).json(result.body);
    res.status(201).json(await loadBaseExercise(req, result.id));
  } catch (err) { next(err); }
});

/* ── Update ───────────────────────────────────────────────────────────────── */

/**
 * Updates a Base Exercise's own content (`PUT /platform/exercises/:id`, and an
 * import of a slug a row already carries, #2952). A field the body does not name
 * keeps what is stored; the muscles and the Recorded Metrics are replaced only
 * when the body names them, which an import never does. Throws the metric-removal
 * confirmation error `respondMetricRemoval()` answers.
 */
export async function updateBaseExercise(
  req: Request,
  id: number | string,
  body: Record<string, any>,
): Promise<BaseExerciseWriteResult> {
  const {
    name, description,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, status,
  } = body;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return refuse(400, `status must be one of: ${SETTABLE_STATUSES.join(', ')}`);
  }
  const muscles = parseMuscles(body.muscles);
  if (typeof muscles === 'string') return refuse(400, muscles);
  const categoryInput = parseExerciseCategoryInput(body);
  if (categoryInput.error) return refuse(400, categoryInput.error);
  const equipmentInput = parseExerciseEquipmentInput(body);
  if (equipmentInput.error) return refuse(400, equipmentInput.error);
  let metricsRequest;
  try { metricsRequest = parseRecordedMetricsRequest(body); }
  catch (e: any) { return refuse(e.status ?? 400, e.message); }
  // #967: replace-all when the field is sent, untouched when it is not — the
  // gym-side rule, for the same reason (a client editing another field must not
  // clear the catalogue's translations).
  const { translations, error: translationsError } = parseExerciseTranslations(body);
  if (translationsError) return refuse(400, translationsError);
  // #1419: the description in every other language, and the base short one.
  const { descriptionTranslations, error: descTranslationsError } = parseDescriptionTranslations(body);
  if (descTranslationsError) return refuse(400, descTranslationsError);
  const shortDescription = parseShortDescription(body);
  if (shortDescription.error) return refuse(400, shortDescription.error);
  const actor = platformActor(req);
  const { rows: existing } = await db.query(
    `SELECT id FROM ${B.exercises} WHERE id = ? AND status != 'deleted'`,
    [id],
  );
  if (existing.length === 0) return refuse(404, 'Exercise not found');
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (trimmedName && await nameTaken(trimmedName, id)) {
    return refuse(409, 'A base exercise with this name already exists.');
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
        equipment             = IF(?, ?, equipment),
        status                = COALESCE(?, status),
        modified_at           = UTC_TIMESTAMP(),
        -- #1182: who last changed it, snapshotted beside when.
        modified_by           = ?
       WHERE id = ? AND status != 'deleted'`,
      [
        trimmedName || null,
        'description' in body ? 1 : 0, description ?? null,
        shortDescription.provided ? 1 : 0, shortDescription.value,
        'min_reps_default' in body ? 1 : 0, min_reps_default ?? null,
        'max_reps_default' in body ? 1 : 0, max_reps_default ?? null,
        'rest_default_seconds' in body ? 1 : 0, rest_default_seconds ?? null,
        'sets_default' in body ? 1 : 0, sets_default ?? null,
        categoryInput.provided ? 1 : 0, categoryInput.value,
        equipmentInput.provided ? 1 : 0, equipmentInput.value,
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
    // #2225: a category change never rewrites the configured Recorded Metrics.
    await applyRecordedMetrics(tx, id, null, metricsRequest, B);
    if (translations) await replaceExerciseTranslations(tx, id, translations, B);
    if (descriptionTranslations) await replaceExerciseDescriptionTranslations(tx, id, descriptionTranslations, B);
  });
  recordAudit(req, { action: 'update', entityType: 'exercise', entityId: id, next: await loadBaseExercise(req, id) });
  return { ok: true, id };
}

platformExercisesRouter.put('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const result = await updateBaseExercise(req, id, req.body ?? {});
    if (!result.ok) return res.status(result.status).json(result.body);
    res.json(await loadBaseExercise(req, id));
  } catch (err) { if (respondMetricRemoval(err, res)) return; next(err); }
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
/**
 * The Base Exercise media routes and their image writer, which Cordel's import
 * (#2952) calls with a slug-resolved id and the picture's bytes.
 */
export const baseExerciseMedia = createExerciseGenderMedia({
  scope: 'platform',
  guard: requireSuperadmin,
  respond: async (req, res, id) => {
    res.json(await loadBaseExercise(req, id));
  },
});
platformExercisesRouter.use(baseExerciseMedia.router);
