import express, { Request, Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { MUSCLE_KEYS, normalizeMuscleKey } from '../domain/muscles';
import { getReferences } from '../domain/references';
import { handleDupEntry } from '../infra/db-helpers';
import {
  EXERCISE_IMAGE_MASTER_MAX_BYTES,
  EXERCISE_IMAGE_MIME,
  EXERCISE_IMAGE_THUMBNAIL_MAX_BYTES,
  buildGymExerciseImageKey,
  buildGymExerciseImageThumbnailKey,
  gymExerciseImageFolderKeys,
  isGymOwnedImageUrl,
  validateExerciseImagePair,
} from '../domain/exerciseImages';
import {
  EXERCISE_MEDIA_COLUMNS,
  ExerciseMediaRefs,
  mediaRefsAfterRefresh,
  planExerciseMediaRefresh,
} from '../domain/exerciseMediaImport';
import {
  EXERCISE_VIDEO_MIME,
  EXERCISE_VIDEO_POSTER_MAX_BYTES,
  EXERCISE_VIDEO_POSTER_MIME,
  buildGymExerciseVideoKey,
  buildGymExerciseVideoPosterKey,
  exerciseVideoMaxBytes,
  gymExerciseVideoFolderKeys,
  validateExerciseVideoPair,
} from '../domain/exerciseVideos';
import {
  StorageOperationError,
  buildStorageObjectUrl,
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  isStorageConfigured,
  storageKeyFromObjectUrl,
  uploadStorageObject,
} from '../infra/storage';
import { mediaIdentity, mediaReferenceClause } from '../domain/exerciseMediaReferences';
import {
  copyExerciseTranslations,
  exerciseTranslationsExpr,
  localizedExerciseNameExpr,
  localizedExerciseNameSql,
  parseExerciseTranslations,
  replaceExerciseTranslations,
  withExerciseTranslations,
} from '../domain/exerciseTranslations';
import {
  exerciseFacetsQuery,
  exerciseListFilterSql,
  groupExerciseFacets,
  parseExerciseListFilter,
} from '../domain/exerciseListFilters';
import { BASE_LOCALE, SUPPORTED_LOCALES, TRANSLATABLE_LOCALES, getRequestLocale } from '../infra/locale';
import { logger } from '../lib/logger';

/**
 * P5.1 / #55: per-gym exercises. #62: muscles are a static in-app catalog
 * (see domain/muscles.ts) — links live in exercise_muscles keyed by muscle
 * slug. Exercise delete is a soft delete (status='deleted' + deleted_at);
 * name uniqueness among non-deleted rows is enforced here because the DB
 * unique index was dropped to let deleted names be reused.
 */

const SETTABLE_STATUSES = ['active', 'inactive'];

/**
 * #718: a single Import request may not name an unbounded list of base
 * exercises — the whole thing runs in one transaction, and the bound is what
 * stops a hand-rolled request from holding it open over the entire catalog.
 * "Select all matching" with no filters is the realistic worst case, so the
 * cap sits well above the size of the Base Exercises library.
 */
const MAX_IMPORT_IDS = 500;

/**
 * One re-imported exercise (#719 part 3): what the media refresh moved, plus the
 * audit pair and the objects it stopped pointing at. The last two never leave
 * the route — `stale` drives the ownership-aware cleanup after the transaction
 * commits, and the response carries only the flags the modal reports.
 */
interface RefreshedImport {
  /** The Base Exercise's id, as the request named it. */
  id: number;
  name: string;
  /** The gym's own copy that was refreshed. */
  exercise_id: number;
  image_refreshed: boolean;
  video_refreshed: boolean;
  previous: ExerciseMediaRefs;
  next: ExerciseMediaRefs;
  stale: string[];
}

export const musclesRouter = Router();
export const exercisesRouter = Router();

/* ---- Muscles: read-only static catalog ---- */
musclesRouter.get('/', (_req, res) => {
  res.json(MUSCLE_KEYS.map((key) => ({ key })));
});

/* ---- Exercises ---- */
/**
 * #967: `name` stays the base (English) value an edit form submits back, and the
 * row carries the caller's language beside it as `display_name` — resolved in
 * SQL from `exercise_translations`, falling back to `name`. Prefilling a form
 * from a translation and saving would overwrite the English original, which is
 * why the two are separate fields rather than one localized `name` (#643).
 *
 * #965/migration 208 added `created_by_name` / `created_by_type` /
 * `modified_by_name` / `modified_by_type` to `exercises`, written **only** by the
 * platform router and therefore only ever on a Base Exercise — a superadmin has
 * no `gym_memberships` row for `created_by` to point at. A gym-owned exercise's
 * actor is still the membership this query joins.
 *
 * Which means the four aliases below do two jobs. They mask the platform actor
 * on a `gym_id IS NULL` row, because this router serves base rows too
 * (`GET /exercises/:id`) and a shared catalogue's rows are not the reading gym's
 * to attribute — their administrator is a Cordel employee, and the catalogue is
 * deliberately shared while their name is not (the rule
 * `itemDetailColumnsSql`'s `maskPlatformActors` already applies to the Nutrition
 * Library). And they shadow the raw columns `e.*` now expands to, which is why
 * they must stay **after** `e.*`: mysql2 builds the row object in field order, so
 * the last field of a duplicated name is the one that survives. Keep every use of
 * `selectFor()` top-level for the same reason — wrapping it in a derived table or
 * a view would raise ER_DUP_FIELDNAME.
 */
const selectFor = (locale: Parameters<typeof localizedExerciseNameExpr>[1]) => `
  SELECT e.*,
    ${localizedExerciseNameExpr('e', locale, 'display_name')},
    ${exerciseTranslationsExpr('e')},
    CASE WHEN e.gym_id IS NULL THEN NULL ELSE gm_c.name END           AS created_by_name,
    CASE WHEN e.gym_id IS NULL THEN NULL ELSE e.created_by_type END   AS created_by_type,
    CASE WHEN e.gym_id IS NULL THEN NULL ELSE gm_m.name END           AS modified_by_name,
    CASE WHEN e.gym_id IS NULL THEN NULL ELSE e.modified_by_type END  AS modified_by_type,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('key', em.muscle, 'role', em.role))
     FROM exercise_muscles em WHERE em.exercise_id = e.id) AS muscles,
    (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', rt.id, 'name', rt.name, 'slug', rt.slug))
     FROM exercise_allowed_result_types eart
     JOIN result_types rt ON rt.id = eart.result_type_id
     WHERE eart.exercise_id = e.id ORDER BY rt.id) AS allowed_result_types
  FROM exercises e
  LEFT JOIN gym_memberships gm_c ON gm_c.id = e.created_by
  LEFT JOIN gym_memberships gm_m ON gm_m.id = e.modified_by
`;

/**
 * The row as the caller reads it. Every route builds its SELECT from the
 * request's own locale so a write's response, a duplicate's and an import's
 * carry the same `display_name` a list read would.
 */
const selectForReq = (req: Request) => selectFor(getRequestLocale(req));

async function getCallerMembershipId(req: Request): Promise<number | null> {
  const userId = req.auth?.userId;
  if (!userId) return null;
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT id FROM gym_memberships WHERE gym_id = ? AND user_id = ? LIMIT 1',
    [gymId, userId],
  );
  return rows.length > 0 ? rows[0].id : null;
}

/** Parses body.muscles into normalized {key, role} pairs; returns an error string on bad input. */
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

async function replaceAllowedResultTypes(tx: Tx, exerciseId: number | string, ids: number[]) {
  await tx.query('DELETE FROM exercise_allowed_result_types WHERE exercise_id = ?', [exerciseId]);
  for (const rtId of ids) {
    await tx.query(
      'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
      [exerciseId, rtId],
    );
  }
}

async function replaceMuscles(tx: Tx, gymId: string, exerciseId: number | string, muscles: { key: string; role: string }[]) {
  await tx.query('DELETE FROM exercise_muscles WHERE exercise_id = ? AND gym_id = ?', [exerciseId, gymId]);
  for (const m of muscles) {
    await tx.query(
      'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (?, ?, ?, ?)',
      [gymId, exerciseId, m.key, m.role],
    );
  }
}

/** 409-style duplicate check among non-deleted exercises (DB unique was dropped for soft delete). */
async function nameTaken(gymId: string, name: string, excludeId?: string | number): Promise<boolean> {
  const params: any[] = [gymId, name];
  let sql = "SELECT id FROM exercises WHERE gym_id = ? AND name = ? AND status != 'deleted'";
  if (excludeId !== undefined) { sql += ' AND id != ?'; params.push(excludeId); }
  const { rows } = await db.query(sql, params);
  return rows.length > 0;
}

/** The rows this list owns: the gym's own, minus the soft-deleted. */
const GYM_SCOPE_SQL = "e.gym_id = ? AND e.status != 'deleted'";

/**
 * The gym's own catalogue, and only that (#804). A Base Exercise
 * (`gym_id IS NULL`) reaches a gym by being **imported** — `POST
 * /exercises/import` writes the gym's own copy and records provenance in
 * `cloned_from_id` — so the copy is the import state and existing in the
 * platform library is not: a base row the gym never imported has no business
 * in this list, and adding one to the library must not make it appear in every
 * gym's Exercises page. Filtering here rather than per-control is what keeps
 * `?q=` and `?status=` from reaching it either (#804 §10), and it is also what
 * the write paths already assume — `workout-templates.ts` and
 * `training-plans.ts` validate an `exercise_id` with `gym_id = ?`, so a base row
 * this endpoint used to offer the exercise pickers was rejected the moment it
 * was picked. `GET /exercises/base` is where the library is read (the Import
 * modal), and `GET /exercises/:id` still answers for a base row — #804 §15
 * leaves Exercise details alone, and a base row is readable by the gym there
 * and through the library either way.
 *
 * #969 stage 2: the gym's Exercises page is the third of the ticket's three
 * screens, so its filters are the **same** ones — one vocabulary, one `WHERE`
 * builder (`domain/exerciseListFilters.ts`), applied server-side (§16/§19).
 * The search still matches the base name or any stored translation (#967 §7),
 * because that rule now lives in that builder rather than in this route.
 *
 * The same reasoning as the slug (never searched, #1356) is why the Equipment
 * and Category dropdowns are absent there: the facets come back empty (`GET /exercises/facets`) and §9
 * says a control with no values is not rendered at all.
 */
exercisesRouter.get('/', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const parsed = parseExerciseListFilter(req.query as Record<string, unknown>);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  const locale = getRequestLocale(req);
  const where = exerciseListFilterSql('e', parsed.filter);
  // Ordering follows the *displayed* name, because that is what the page shows (#643).
  const sql = `${selectFor(locale)} WHERE ${GYM_SCOPE_SQL}${where.sql}`
    + ` ORDER BY ${localizedExerciseNameSql('e', locale)} ASC`;
  try {
    const { rows } = await db.query(sql, [gymId, ...where.params]);
    res.json(rows.map(withExerciseTranslations));
  } catch (err) { next(err); }
});

/**
 * What this screen's filter dropdowns offer, plus the unfiltered total
 * `Showing 42 of 612` counts against (#969 §8, §9, §14) — the gym-scoped
 * counterpart of `GET /platform/exercises/facets`.
 *
 * It reports the same shape for the same reason: the options are the values
 * **present** among the gym's own exercises, never a declared list, so a
 * catalogue whose rows carry no source metadata (which is every gym's today —
 * only #964's importer writes those columns, and only on `gym_id IS NULL` rows)
 * renders no Equipment or Category control rather than an empty one. The total
 * is what the count needs either way.
 *
 * Registered **before** `/:id`, or Express reads `facets` as an exercise id.
 */
exercisesRouter.get('/facets', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const facetQuery = exerciseFacetsQuery(GYM_SCOPE_SQL, [gymId]);
  try {
    const [facets, totals] = await Promise.all([
      db.query(facetQuery.sql, facetQuery.params),
      db.query(`SELECT COUNT(*) AS total FROM exercises e WHERE ${GYM_SCOPE_SQL}`, [gymId]),
    ]);
    res.json({
      total: Number(totals.rows[0]?.total ?? 0),
      ...groupExerciseFacets(facets.rows as { facet: string; value: string }[]),
    });
  } catch (err) { next(err); }
});

/**
 * #967 §3: the languages an exercise name may be entered in, so the editor
 * renders one input per translatable locale instead of hardcoding a second copy
 * of the application's language list (the ticket's closing "Important"). Same
 * contract as `GET /platform/nutrition-library/locales` (#643), served here
 * because the gym-facing Exercises page reads its catalogues from this router.
 *
 * Registered **before** `/:id`, or Express reads `locales` as an exercise id.
 */
exercisesRouter.get('/locales', (_req, res) => {
  res.json({ locales: SUPPORTED_LOCALES, base_locale: BASE_LOCALE, translatable: TRANSLATABLE_LOCALES });
});

/**
 * #718: the Base Exercises library as the Import Exercises modal needs it.
 * Gym-facing on purpose — `/platform/exercises` is superadmin-only, and a gym
 * admin importing a base exercise is not a platform administrator. Read-only,
 * and both filters are applied here so the modal never pulls the whole library
 * into the browser to filter it there.
 *
 * `imported_exercise_id` is what marks a row as already imported: the gym's own
 * copy, matched either by provenance (`cloned_from_id`) or by name. The name
 * arm matters — an exercise that reached the gym before this endpoint existed
 * (the retired Import Defaults seed, or one typed by hand) carries no
 * provenance, and offering it again would only produce a duplicate name.
 */
const IMPORTED_COPY_ID = `
  (SELECT MIN(g.id) FROM exercises g
    WHERE g.gym_id = ? AND g.status != 'deleted'
      AND (g.cloned_from_id = e.id OR g.name = e.name))`;

/**
 * #719 part 3 (§12): whether re-importing this Base Exercise would actually move
 * the gym copy's media — the flag the Import modal needs to offer a row it
 * otherwise disables as already imported.
 *
 * Mirrors `planExerciseMediaRefresh()` exactly, so the row the modal offers is
 * the row the import refreshes: the image pair and the video pair are
 * independent, and a pair the Base Exercise does not have (`e.image_url IS
 * NULL`) counts for nothing — re-import restores System media, it never clears a
 * gym's own upload. `<=>` is NULL-safe, so "both absent" reads as unchanged.
 *
 * `ORDER BY g.id LIMIT 1` picks the same copy `MIN(g.id)` does above, and the
 * same one `POST /import` refreshes, for a gym that somehow holds two matches
 * (one by provenance, one by name).
 */
const MEDIA_REFRESHABLE = `
  COALESCE((SELECT
      CASE WHEN (e.image_url IS NOT NULL
                  AND NOT ((g.image_url <=> e.image_url) AND (g.image_thumbnail_url <=> e.image_thumbnail_url)))
                OR (e.video_url IS NOT NULL
                  AND NOT ((g.video_url <=> e.video_url) AND (g.video_thumbnail_url <=> e.video_thumbnail_url)))
        THEN 1 ELSE 0 END
    FROM exercises g
    WHERE g.gym_id = ? AND g.status != 'deleted'
      AND (g.cloned_from_id = e.id OR g.name = e.name)
    ORDER BY g.id ASC LIMIT 1), 0)`;

/**
 * The library as the Import modal reads it: the platform's own exercises, and
 * only the ones a gym may actually import (`status = 'active'`).
 */
const BASE_LIBRARY_SCOPE_SQL = "e.gym_id IS NULL AND e.status = 'active'";

/**
 * #969 stage 2: the Import modal is the second of the ticket's three screens,
 * and it now reads the identical filter vocabulary — the hand-rolled `?q=` and
 * single `?muscle=` this route carried are `domain/exerciseListFilters.ts`'s
 * clauses, so a muscle selection means the same thing here, on Base Exercises
 * and on a gym's own list (§19), and the modal gets §4–§9's filters for free.
 *
 * Two consequences worth naming. And an unknown muscle key is no
 * longer a `400`: the filter vocabulary is one vocabulary, in which only
 * `status` and `muscle_match` are closed sets — #964 §8 lets the importer store
 * a muscle key outside `MUSCLE_KEYS` rather than fail, so a filter that refused
 * one would make a legitimately stored muscle unfilterable. An unmatched key
 * now simply returns nothing, which is what the other two screens already did.
 */
exercisesRouter.get('/base', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const parsed = parseExerciseListFilter(req.query as Record<string, unknown>);
  if ('error' in parsed) return res.status(400).json({ error: parsed.error });
  // The `?`s inside IMPORTED_COPY_ID and MEDIA_REFRESHABLE sit in the SELECT
  // list, so their gymIds bind before the WHERE-clause filters below, in order.
  const locale = getRequestLocale(req);
  const where = exerciseListFilterSql('e', parsed.filter);
  const sql = `
    SELECT e.id, e.name, ${localizedExerciseNameExpr('e', locale, 'display_name')},
      e.slug, e.description, e.image_url, e.image_thumbnail_url,
      e.video_url, e.video_thumbnail_url,
      (SELECT JSON_ARRAYAGG(JSON_OBJECT('key', em.muscle, 'role', em.role))
       FROM exercise_muscles em WHERE em.exercise_id = e.id) AS muscles,
      ${IMPORTED_COPY_ID} AS imported_exercise_id,
      ${MEDIA_REFRESHABLE} AS media_refreshable
    FROM exercises e
    WHERE ${BASE_LIBRARY_SCOPE_SQL}${where.sql}
    ORDER BY ${localizedExerciseNameSql('e', locale)} ASC`;
  try {
    const { rows } = await db.query(sql, [gymId, gymId, ...where.params]);
    // MySQL answers the CASE with 0/1; the contract is a boolean.
    res.json(rows.map((row: any) => ({ ...row, media_refreshable: Number(row.media_refreshable) === 1 })));
  } catch (err) { next(err); }
});

/**
 * The Import modal's own facets and unfiltered total (#969 §8, §9, §14), over
 * the library's scope rather than the gym's.
 *
 * Gym-facing on purpose, exactly as `/base` is: `GET
 * /platform/exercises/facets` is superadmin-only, and a gym admin importing a
 * Base Exercise is not a platform administrator (#718). It is the same
 * statement either way — the scope is the only parameter.
 */
exercisesRouter.get('/base/facets', async (_req, res, next) => {
  const facetQuery = exerciseFacetsQuery(BASE_LIBRARY_SCOPE_SQL);
  try {
    const [facets, totals] = await Promise.all([
      db.query(facetQuery.sql, facetQuery.params),
      db.query(`SELECT COUNT(*) AS total FROM exercises e WHERE ${BASE_LIBRARY_SCOPE_SQL}`),
    ]);
    res.json({
      total: Number(totals.rows[0]?.total ?? 0),
      ...groupExerciseFacets(facets.rows as { facet: string; value: string }[]),
    });
  } catch (err) { next(err); }
});

/**
 * #967: the single-row read carries `translations` ({ locale: name }) beside the
 * base `name` and the resolved `display_name` — the editor seeds its per-locale
 * inputs from it, and the list read deliberately does not pay for them.
 */
exercisesRouter.get('/:id', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `${selectForReq(req)} WHERE e.id = ? AND (e.gym_id = ? OR e.gym_id IS NULL) AND e.status != 'deleted'`,
      [req.params.id, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Exercise not found' });
    res.json(withExerciseTranslations(rows[0]));
  } catch (err) { next(err); }
});

/** #62: where this exercise is used (non-deleted workout templates). */
exercisesRouter.get('/:id/references', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    res.json(await getReferences('exercise', gymId, Number(req.params.id)));
  } catch (err) { next(err); }
});

exercisesRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const {
    name, description, video_url, image_url,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
    status,
  } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const muscles = parseMuscles(req.body.muscles);
  if (typeof muscles === 'string') return res.status(400).json({ error: muscles });
  const allowedResultTypeIds: number[] | undefined =
    Array.isArray(req.body.allowed_result_type_ids) ? req.body.allowed_result_type_ids.map(Number) : undefined;
  // #967: the name in every other supported language. A request that omits the
  // field creates an exercise with its base name alone — a translation is never
  // invented for it (§5, §9).
  const { translations, error: translationsError } = parseExerciseTranslations(req.body);
  if (translationsError) return res.status(400).json({ error: translationsError });
  try {
    if (await nameTaken(gymId, name.trim())) {
      return res.status(409).json({ error: 'Exercise with this name already exists.' });
    }
    const callerMemberId = await getCallerMembershipId(req);
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO exercises
          (gym_id, name, description, video_url, image_url,
           min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, name.trim(), description ?? null, video_url ?? null, image_url ?? null,
         min_reps_default ?? null, max_reps_default ?? null, rest_default_seconds ?? null,
         sets_default ?? null, notes_default ?? null, status ?? 'active', callerMemberId ?? null],
      );
      if (muscles) await replaceMuscles(tx, gymId, insertId, muscles);
      if (allowedResultTypeIds) await replaceAllowedResultTypes(tx, insertId, allowedResultTypeIds);
      if (translations) await replaceExerciseTranslations(tx, insertId, translations);
      return insertId;
    });
    const { rows } = await db.query(`${selectForReq(req)} WHERE e.id = ?`, [insertId]);
    const created = withExerciseTranslations(rows[0]);
    recordAudit(req, { action: 'create', entityType: 'exercise', entityId: insertId, next: created });
    res.status(201).json(created);
  } catch (e: any) {
    handleDupEntry(e, res, next, 'Exercise with this name already exists.');
  }
});

exercisesRouter.put('/:id', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const id = String(req.params.id);
  // Guard: base exercises (gym_id IS NULL) may only be modified via /platform/exercises
  const { rows: ownerCheck } = await db.query('SELECT gym_id FROM exercises WHERE id = ?', [id]);
  if (ownerCheck.length > 0 && ownerCheck[0].gym_id === null) {
    return res.status(403).json({ error: 'Base exercises can only be modified by Cordel administrators.' });
  }
  const {
    name, description, video_url, image_url,
    min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
    status,
  } = req.body;
  if (status && !SETTABLE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${SETTABLE_STATUSES.join(', ')}` });
  }
  const muscles = parseMuscles(req.body.muscles);
  if (typeof muscles === 'string') return res.status(400).json({ error: muscles });
  const allowedResultTypeIds: number[] | undefined =
    Array.isArray(req.body.allowed_result_type_ids) ? req.body.allowed_result_type_ids.map(Number) : undefined;
  // #967: replace-all, like every other collection this PUT carries — the
  // payload is the complete set, so a locale left blank loses its row and falls
  // back to the base name. A request that does not mention `translations` at all
  // leaves the stored rows alone, so a client written before this ticket (or one
  // editing another field) cannot silently clear a gym's translations.
  const { translations, error: translationsError } = parseExerciseTranslations(req.body);
  if (translationsError) return res.status(400).json({ error: translationsError });
  try {
    if (name?.trim() && await nameTaken(gymId, name.trim(), id)) {
      return res.status(409).json({ error: 'Exercise with this name already exists.' });
    }
    const callerMemberId = await getCallerMembershipId(req);
    await db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE exercises SET
          name                  = COALESCE(?, name),
          description           = IF(?, ?, description),
          video_url             = IF(?, ?, video_url),
          -- #719 part 2: the poster belongs to the video it was captured from,
          -- so a PUT that repoints video_url (at a YouTube link, say) drops it
          -- rather than leaving a still of some other clip behind. POST
          -- /:id/video is the only writer that sets the two together.
          video_thumbnail_url   = IF(?, NULL, video_thumbnail_url),
          image_url              = IF(?, ?, image_url),
          -- #719: the thumbnail belongs to the master it was made from. A PUT
          -- that sets image_url is pointing the exercise at some *other* image
          -- (an external link, or a legacy uuid.png upload), which has no
          -- 512×512 companion — keeping the old one would pair a thumbnail
          -- with an image it does not depict. POST /:id/image is the only
          -- writer that sets the two together.
          image_thumbnail_url   = IF(?, NULL, image_thumbnail_url),
          min_reps_default      = IF(?, ?, min_reps_default),
          max_reps_default      = IF(?, ?, max_reps_default),
          rest_default_seconds  = IF(?, ?, rest_default_seconds),
          sets_default          = IF(?, ?, sets_default),
          notes_default         = IF(?, ?, notes_default),
          status                = COALESCE(?, status),
          modified_at           = UTC_TIMESTAMP(),
          modified_by           = ?
         WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
        [
          name?.trim() ?? null,
          'description' in req.body ? 1 : 0, description ?? null,
          'video_url' in req.body ? 1 : 0, video_url ?? null,
          'video_url' in req.body ? 1 : 0,
          'image_url' in req.body ? 1 : 0, image_url ?? null,
          'image_url' in req.body ? 1 : 0,
          'min_reps_default' in req.body ? 1 : 0, min_reps_default ?? null,
          'max_reps_default' in req.body ? 1 : 0, max_reps_default ?? null,
          'rest_default_seconds' in req.body ? 1 : 0, rest_default_seconds ?? null,
          'sets_default' in req.body ? 1 : 0, sets_default ?? null,
          'notes_default' in req.body ? 1 : 0, notes_default ?? null,
          status ?? null,
          callerMemberId ?? null,
          id, gymId,
        ],
      );
      if (rowCount === 0) throw Object.assign(new Error('Exercise not found'), { status: 404 });
      if (muscles) await replaceMuscles(tx, gymId, id, muscles);
      if (allowedResultTypeIds) await replaceAllowedResultTypes(tx, id, allowedResultTypeIds);
      if (translations) await replaceExerciseTranslations(tx, id, translations);
    });
    const { rows } = await db.query(`${selectForReq(req)} WHERE e.id = ? AND e.gym_id = ?`, [id, gymId]);
    const updated = withExerciseTranslations(rows[0]);
    recordAudit(req, { action: 'update', entityType: 'exercise', entityId: id, next: updated });
    res.json(updated);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    handleDupEntry(e, res, next, 'Exercise with this name already exists.');
  }
});

exercisesRouter.delete('/:id', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId, actorName } = getTenantContext(req);
  const { rows: ownerCheck } = await db.query('SELECT gym_id FROM exercises WHERE id = ?', [req.params.id]);
  if (ownerCheck.length > 0 && ownerCheck[0].gym_id === null) {
    return res.status(403).json({ error: 'Base exercises can only be modified by Cordel administrators.' });
  }
  const callerMemberId = await getCallerMembershipId(req);
  const { rowCount } = await db.query(
    `UPDATE exercises SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by = ?, deleted_by_name = ?
      WHERE id = ? AND gym_id = ? AND status != 'deleted'`,
    [callerMemberId ?? null, actorName, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Exercise not found' });
  recordAudit(req, { action: 'delete', entityType: 'exercise', entityId: req.params.id });
  res.status(204).send();
});

exercisesRouter.post('/:id/duplicate', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const id = String(req.params.id);
  try {
    const { rows: orig } = await db.query(
      `${selectForReq(req)} WHERE e.id = ? AND e.gym_id = ? AND e.status != 'deleted'`,
      [id, gymId],
    );
    if (orig.length === 0) return res.status(404).json({ error: 'Exercise not found' });
    const src = orig[0];
    const callerMemberId = await getCallerMembershipId(req);
    const copyName = `${src.name} (Copy)`;

    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO exercises
          (gym_id, name, description, video_url, video_thumbnail_url, image_url, image_thumbnail_url,
           min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
           status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        // #719: each thumbnail travels with the media it depicts. Both copies
        // point at the *same* objects — nothing is duplicated in R2 — which is
        // why removing one exercise's media only deletes an object when no
        // other exercise still references it (`isMediaStillReferenced()`).
        [gymId, copyName, src.description, src.video_url, src.video_thumbnail_url, src.image_url, src.image_thumbnail_url,
         src.min_reps_default, src.max_reps_default, src.rest_default_seconds, src.sets_default, src.notes_default,
         callerMemberId ?? null],
      );
      const muscles: { key: string; role: string }[] = Array.isArray(src.muscles) ? src.muscles : [];
      for (const m of muscles) {
        await tx.query(
          'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (?, ?, ?, ?)',
          [gymId, insertId, m.key, m.role],
        );
      }
      const rts: { id: number }[] = Array.isArray(src.allowed_result_types) ? src.allowed_result_types : [];
      for (const rt of rts) {
        await tx.query(
          'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
          [insertId, rt.id],
        );
      }
      // #967: a copy is a copy — the per-locale names travel with the name they
      // translate, or the copy would read in English for every viewer the
      // original served in their own language.
      await copyExerciseTranslations(tx, id, insertId);
      return insertId;
    });

    const { rows } = await db.query(`${selectForReq(req)} WHERE e.id = ? AND e.gym_id = ?`, [insertId, gymId]);
    recordAudit(req, { action: 'create', entityType: 'exercise', entityId: insertId, next: rows[0] });
    res.status(201).json(withExerciseTranslations(rows[0]));
  } catch (err) { next(err); }
});

/** Clone a base exercise into the gym's own catalog. */
exercisesRouter.post('/:id/clone', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const id = String(req.params.id);
  try {
    const { rows: orig } = await db.query(
      `${selectForReq(req)} WHERE e.id = ? AND e.gym_id IS NULL AND e.status != 'deleted'`,
      [id],
    );
    if (orig.length === 0) return res.status(404).json({ error: 'Base exercise not found' });
    const src = orig[0];
    const callerMemberId = await getCallerMembershipId(req);
    const copyName = `${src.name} (Copy)`;

    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO exercises
          (gym_id, name, description, video_url, video_thumbnail_url, image_url, image_thumbnail_url,
           min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
           status, created_by, cloned_from_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        // #719 §2: the copy takes the Base Exercise's media *references*, not
        // its bytes — no System object is duplicated into the gym's folder, and
        // the copy owns the references from here on (§3's snapshot rule).
        [gymId, copyName, src.description, src.video_url, src.video_thumbnail_url, src.image_url, src.image_thumbnail_url,
         src.min_reps_default, src.max_reps_default, src.rest_default_seconds, src.sets_default, src.notes_default,
         callerMemberId ?? null, id],
      );
      const muscles: { key: string; role: string }[] = Array.isArray(src.muscles) ? src.muscles : [];
      for (const m of muscles) {
        await tx.query(
          'INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (?, ?, ?, ?)',
          [gymId, insertId, m.key, m.role],
        );
      }
      const rts: { id: number }[] = Array.isArray(src.allowed_result_types) ? src.allowed_result_types : [];
      for (const rt of rts) {
        await tx.query(
          'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
          [insertId, rt.id],
        );
      }
      // #967: a copy is a copy — the per-locale names travel with the name they
      // translate, or the copy would read in English for every viewer the
      // original served in their own language.
      await copyExerciseTranslations(tx, id, insertId);
      return insertId;
    });

    const { rows } = await db.query(`${selectForReq(req)} WHERE e.id = ? AND e.gym_id = ?`, [insertId, gymId]);
    recordAudit(req, { action: 'create', entityType: 'exercise', entityId: insertId, next: rows[0] });
    res.status(201).json(withExerciseTranslations(rows[0]));
  } catch (err) { next(err); }
});

/**
 * #718: import selected Base Exercises into the gym's own catalog, in one
 * request. Replaces `POST /import-defaults`, which seeded eight hardcoded
 * names that had nothing to do with the platform's Base Exercises library —
 * the library is the source of truth for what a gym can start from.
 *
 * Each import is the copy `POST /:id/clone` makes — same columns, same
 * `cloned_from_id` provenance — except that it keeps the base exercise's name
 * instead of appending "(Copy)": importing fifty exercises named "… (Copy)" is
 * not what the gym asked for, and the name is free because an exercise the gym
 * already has is skipped instead of copied.
 *
 * Unknown ids are rejected outright (400) rather than silently dropped — a gym
 * exercise's id, another gym's exercise, an inactive or deleted base row and a
 * nonexistent id all fail the same lookup, so none of them can be smuggled into
 * a gym's catalog through this route. Ids the gym already has are *not* an
 * error: the modal hides them, but a concurrent import would otherwise turn a
 * harmless race into a failed batch, so they come back under `skipped`.
 *
 * #719 part 3 (§12): an id the gym already has is also how it gets the **System
 * media** back. Re-importing refreshes that copy's media references from the
 * Base Exercise's current ones — the only supported restore path, since §12
 * rules out a separate "restore System media" action and §3 rules out any
 * runtime fallback. It refreshes *media only*: the name, description, defaults,
 * muscles, result types and `cloned_from_id` of a copy the gym may have edited
 * are its own. A copy that already carries the current references, or whose Base
 * Exercise has no media to give, stays `skipped` exactly as before; one that
 * moves comes back under `refreshed`.
 */
exercisesRouter.post('/import', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const raw = req.body?.baseExerciseIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: 'baseExerciseIds must be a non-empty array of base exercise ids' });
  }
  if (raw.length > MAX_IMPORT_IDS) {
    return res.status(400).json({ error: `baseExerciseIds may not contain more than ${MAX_IMPORT_IDS} ids` });
  }
  const ids: number[] = [];
  for (const value of raw) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: `invalid base exercise id: ${JSON.stringify(value)}` });
    }
    if (!ids.includes(id)) ids.push(id);
  }
  try {
    const marks = ids.map(() => '?').join(',');
    const { rows: baseRows } = await db.query(
      `${selectForReq(req)} WHERE e.id IN (${marks}) AND e.gym_id IS NULL AND e.status = 'active'`,
      ids,
    );
    const base = new Map<number, any>(baseRows.map((row: any) => [Number(row.id), row]));
    const invalidIds = ids.filter((id) => !base.has(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({
        error: 'Some ids are not importable base exercises.',
        invalid_ids: invalidIds,
      });
    }

    const callerMemberId = await getCallerMembershipId(req);
    const { insertedIds, refreshed, skipped } = await db.transaction(async (tx) => {
      const insertedIds: number[] = [];
      const refreshed: RefreshedImport[] = [];
      const skipped: { id: number; name: string; reason: string; exercise_id: number }[] = [];
      for (const id of ids) {
        const src = base.get(id);
        // `ORDER BY id` so the copy refreshed here is the one MEDIA_REFRESHABLE
        // reported on, for a gym that holds both a provenance and a name match.
        const { rows: existing } = await tx.query<ExerciseMediaRow>(
          `SELECT id, name, image_url, image_thumbnail_url, video_url, video_thumbnail_url
             FROM exercises
            WHERE gym_id = ? AND status != 'deleted' AND (cloned_from_id = ? OR name = ?)
            ORDER BY id ASC LIMIT 1`,
          [gymId, id, src.name],
        );
        if (existing.length > 0) {
          const copy = existing[0];
          // #719 §12: re-import restores the Base Exercise's current media
          // references onto the copy the gym already has. Media only, and only
          // the pairs the Base Exercise actually has.
          const plan = planExerciseMediaRefresh(src, copy);
          if (!plan) {
            skipped.push({ id, name: src.name, reason: 'already_imported', exercise_id: copy.id });
            continue;
          }
          // Column names come from EXERCISE_MEDIA_COLUMNS, never from the plan's
          // own keys, so nothing but this module's literals reaches the SQL.
          const columns = EXERCISE_MEDIA_COLUMNS.filter((c) => c in plan.changes);
          await tx.query(
            `UPDATE exercises SET ${columns.map((c) => `${c} = ?`).join(', ')},
               modified_at = UTC_TIMESTAMP(), modified_by = ?
              WHERE id = ? AND gym_id = ?`,
            [...columns.map((c) => plan.changes[c] ?? null), callerMemberId ?? null, copy.id, gymId],
          );
          refreshed.push({
            id,
            name: src.name,
            exercise_id: copy.id,
            image_refreshed: plan.image,
            video_refreshed: plan.video,
            previous: {
              image_url: copy.image_url,
              image_thumbnail_url: copy.image_thumbnail_url,
              video_url: copy.video_url,
              video_thumbnail_url: copy.video_thumbnail_url,
            },
            next: mediaRefsAfterRefresh(copy, plan),
            stale: plan.stale,
          });
          continue;
        }
        const { insertId } = await tx.query(
          `INSERT INTO exercises
            (gym_id, name, description, video_url, video_thumbnail_url, image_url, image_thumbnail_url,
             min_reps_default, max_reps_default, rest_default_seconds, sets_default, notes_default,
             status, created_by, cloned_from_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          // #719 §2: references only — the System objects stay where they are.
          [gymId, src.name, src.description, src.video_url, src.video_thumbnail_url, src.image_url, src.image_thumbnail_url,
           src.min_reps_default, src.max_reps_default, src.rest_default_seconds, src.sets_default, src.notes_default,
           callerMemberId ?? null, id],
        );
        const muscles: { key: string; role: string }[] = Array.isArray(src.muscles) ? src.muscles : [];
        await replaceMuscles(tx, gymId, insertId, muscles);
        const rts: { id: number }[] = Array.isArray(src.allowed_result_types) ? src.allowed_result_types : [];
        await replaceAllowedResultTypes(tx, insertId, rts.map((rt) => rt.id));
        // #967 §4: the import preserves the Base Exercise's per-locale names, so
        // the gym's copy reads in the member's own language from the first day.
        // Only on the **create** arm: a re-import refreshes media (#719 §12) and
        // deliberately not translations — the gym may have corrected one, and
        // overwriting that is what §4's "do not overwrite an existing
        // translation" forbids.
        await copyExerciseTranslations(tx, id, insertId);
        insertedIds.push(insertId);
      }
      return { insertedIds, refreshed, skipped };
    });

    let imported: any[] = [];
    if (insertedIds.length > 0) {
      const importedMarks = insertedIds.map(() => '?').join(',');
      const { rows } = await db.query(
        `${selectForReq(req)} WHERE e.id IN (${importedMarks}) AND e.gym_id = ? ORDER BY e.name ASC`,
        [...insertedIds, gymId],
      );
      imported = rows.map(withExerciseTranslations);
      for (const row of rows) {
        recordAudit(req, { action: 'create', entityType: 'exercise', entityId: row.id, next: row });
      }
    }

    // Objects a refreshed copy stopped pointing at, cleaned up *after* the
    // references were committed: a failure here leaves an orphan to sweep rather
    // than an exercise pointing at a missing object, and only this gym's own
    // objects are ever touched — the System object the copy is now pointing at
    // is the whole point of the re-import (§19).
    if (refreshed.length > 0) {
      const folderPrefix = await gymStorageFolderPrefix(gymId);
      for (const entry of refreshed) {
        await deleteReplacedExerciseMedia(
          gymId,
          folderPrefix,
          entry.exercise_id,
          entry.stale,
          [entry.next.image_url, entry.next.image_thumbnail_url, entry.next.video_url, entry.next.video_thumbnail_url],
        );
        recordAudit(req, {
          action: 'update',
          entityType: 'exercise',
          entityId: entry.exercise_id,
          previous: entry.previous,
          next: entry.next,
        });
      }
    }

    res.status(201).json({
      imported,
      refreshed: refreshed.map(({ id, name, exercise_id, image_refreshed, video_refreshed }) => ({
        id, name, exercise_id, image_refreshed, video_refreshed,
      })),
      skipped,
    });
  } catch (err) { next(err); }
});

/* ── Gym Exercise image (#719 part 1) ─────────────────────────────────────── */
//
// A Gym Exercise's image is a **2048×2048 master plus a 512×512 thumbnail**
// (§5), both stored in the gym's own R2 folder under keys derived from the row:
// `<storage_folder_prefix>/Exercises/Images/<id>-<Name>[-thumbnail].png`. The
// route takes neither the folder nor the key from the request — the prefix is
// the gym's own column, the exercise is looked up inside the tenant, and the key
// comes from the row's id and name — so nothing a client sends can reach another
// gym's folder or the platform's (§18).
//
// The **browser** produces the thumbnail (the answer on #719 Q2: no `sharp`, no
// `ffmpeg` in the API image) and uploads both files, which is why the request
// body carries two of them. It is JSON with base64 members rather than
// `multipart/form-data`: the API has no multipart parser and this is one atomic
// request, which matters because a failed thumbnail must fail the whole upload
// rather than leave a master without one. The server validates each file from
// its own bytes — PNG signature, exact square, alpha channel — and never from
// the `Content-Type` header or a file name (§7, §21).
//
// Nothing is uploaded and nothing is written until both pass, so an invalid
// upload cannot disturb the image already there (§8). The old objects are
// deleted only *after* the row points at the new ones, and only when they are
// the gym's own and no other exercise still references them (§19).

/** base64 → Buffer, or null when the value is not base64 at all (an image, a video, a poster). */
function decodeBase64File(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  // A data: URL is what a careless client sends; take the payload rather than
  // decoding the prefix into garbage bytes that would fail as "not a PNG".
  const payload = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  const buffer = Buffer.from(payload, 'base64');
  return buffer.length > 0 ? buffer : null;
}

/**
 * Whether any *other* non-deleted exercise of this gym still points at `url`,
 * through any of its four media references.
 *
 * `POST /:id/duplicate`, `POST /:id/clone` and `POST /import` all copy media
 * *references* (§2: no System object is duplicated, and nothing copies a gym
 * object either), so two rows can legitimately share one object. Deleting the
 * object because one of them replaced or removed its media would break the
 * other, so a shared object is left in the bucket and only the reference goes.
 *
 * All four columns are checked rather than the pair the caller happens to be
 * changing: a video poster and an image thumbnail are both `.png` objects in the
 * same gym's tree, and a row that reached one of them through the other column
 * (an `image_url` hand-set to a poster's URL, say) still counts as a reference.
 */
async function isMediaStillReferenced(gymId: string, url: string, exceptExerciseId: number | string): Promise<boolean> {
  const { clause, params } = mediaReferenceClause(url);
  const { rows } = await db.query(
    `SELECT id FROM exercises
      WHERE gym_id = ? AND id != ? AND status != 'deleted'
        AND ${clause}
      LIMIT 1`,
    [gymId, exceptExerciseId, ...params],
  );
  return rows.length > 0;
}

/**
 * The gym's own R2 folder prefix, or null for a gym whose bucket was never
 * initialized. Deleting media needs it only to answer "is this object mine?" —
 * without it `isGymOwnedImageUrl()` owns nothing and nothing is deleted, which
 * is the safe direction.
 */
async function gymStorageFolderPrefix(gymId: string): Promise<string | null> {
  const { rows } = await db.query<{ storage_folder_prefix: string | null }>(
    'SELECT storage_folder_prefix FROM gyms WHERE id = ? AND deleted_at IS NULL',
    [gymId],
  );
  return rows[0]?.storage_folder_prefix ?? null;
}

/**
 * Best-effort removal of objects an exercise has stopped pointing at. Only ever
 * called *after* the row has been updated, so a failure here leaves an orphan to
 * sweep rather than an exercise pointing at a missing object (§8, §10).
 *
 * `isGymOwnedImageUrl()` is what keeps a System object (`cordel/…`), another
 * gym's object and an external link out of this — a gym operation never deletes
 * media it does not own (§19).
 */
async function deleteReplacedExerciseMedia(
  gymId: string,
  folderPrefix: string | null,
  exerciseId: number | string,
  staleUrls: (string | null)[],
  keepUrls: (string | null)[],
): Promise<void> {
  const keep = new Set(keepUrls.filter((u): u is string => !!u).map(mediaIdentity));
  const seen = new Set<string>();
  for (const url of staleUrls) {
    if (!url) continue;
    const identity = mediaIdentity(url);
    if (keep.has(identity) || seen.has(identity)) continue;
    seen.add(identity);
    if (!isGymOwnedImageUrl(url, folderPrefix)) continue;
    if (await isMediaStillReferenced(gymId, url, exerciseId)) continue;
    const key = storageKeyFromObjectUrl(url);
    if (!key) continue;
    try {
      await deleteStorageObject(key);
    } catch (err: any) {
      const details = err instanceof StorageOperationError
        ? err.details
        : describeStorageError(err, { operation: 'deleteStorageObject', key });
      logger.warn({ err, details, gymId, exerciseId }, 'Replaced exercise media left an orphaned object in Cloudflare R2');
    }
  }
}

/**
 * The columns a media route reads: the row's identity (which is where the object
 * keys come from — never the request) and everything it currently points at, so
 * replacing one pair can tell whether the *other* pair still needs an object
 * kept.
 */
interface ExerciseMediaRow {
  id: number;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
  video_url: string | null;
  video_thumbnail_url: string | null;
}

/**
 * The gym-owned, editable exercise this request is about, or the response that
 * says why there isn't one. A base exercise (`gym_id IS NULL`) answers 403 here
 * exactly as `PUT /:id` does — its media is `/platform/exercises`' business
 * (#716/#717), never a gym's.
 */
async function loadExerciseForMedia(
  req: Request,
  res: express.Response,
  /**
   * An upload needs somewhere to put the object, so a gym whose bucket was never
   * initialized is a 409. Removing an image needs no folder: the references are
   * the gym's to clear whether or not R2 was ever set up, and an object that
   * cannot be identified as the gym's is not deleted anyway.
   */
  options: { requireStoragePrefix: boolean; mediaLabel?: 'images' | 'videos' },
): Promise<{ gymId: string; folderPrefix: string | null; exercise: ExerciseMediaRow } | null> {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query<ExerciseMediaRow & { gym_id: string | null; status: string }>(
    `SELECT id, gym_id, name, status, image_url, image_thumbnail_url, video_url, video_thumbnail_url
       FROM exercises WHERE id = ?`,
    [req.params.id],
  );
  const row = rows[0];
  if (row && row.gym_id === null) {
    res.status(403).json({ error: 'Base exercises can only be modified by Cordel administrators.' });
    return null;
  }
  if (!row || row.gym_id !== gymId || row.status === 'deleted') {
    res.status(404).json({ error: 'Exercise not found' });
    return null;
  }
  const folderPrefix = await gymStorageFolderPrefix(gymId);
  if (!folderPrefix && options.requireStoragePrefix) {
    const media = options.mediaLabel ?? 'images';
    res.status(409).json({ error: `Cloudflare storage has not been initialized for this gym, therefore ${media} cannot be uploaded.` });
    return null;
  }
  return { gymId, folderPrefix, exercise: row };
}

/** The exercise as every other route returns it, after its media changed. */
async function respondWithExercise(req: Request, res: express.Response, gymId: string, id: number | string) {
  const { rows } = await db.query(`${selectForReq(req)} WHERE e.id = ? AND e.gym_id = ?`, [id, gymId]);
  res.json(withExerciseTranslations(rows[0]));
}

/**
 * The body parser for `POST /exercises/:id/image`, and the path it applies to.
 *
 * Mounted in `app.ts` **before** the global `express.json()`, whose default
 * 100 kB limit a pair of PNGs blows through long before this route is reached —
 * the request would fail as 413 with no chance to say which file was too large.
 * body-parser marks a parsed request, so the global parser is a no-op once this
 * one has run; every other route keeps the default limit.
 *
 * The ceiling is the two file limits plus base64's ~4/3 overhead and a little
 * JSON scaffolding. It bounds the request; `validateExerciseImagePair()` is what
 * bounds each file, and answers with the file's own name.
 */
export const EXERCISE_IMAGE_UPLOAD_PATH = /^\/exercises\/[^/]+\/image\/?$/;

export const exerciseImageBodyParser = express.json({
  limit: Math.ceil((EXERCISE_IMAGE_MASTER_MAX_BYTES + EXERCISE_IMAGE_THUMBNAIL_MAX_BYTES) * 1.4),
});

exercisesRouter.post(
  '/:id/image',
  requireModuleWrite('TRAINING'),
  async (req, res, next) => {
    try {
      const image = decodeBase64File(req.body?.image);
      const thumbnail = decodeBase64File(req.body?.thumbnail);
      if (!image || !thumbnail) {
        return res.status(400).json({
          error: 'Both `image` (the 2048×2048 master) and `thumbnail` (the 512×512 thumbnail) are required, base64-encoded.',
        });
      }
      const problem = validateExerciseImagePair(image, thumbnail);
      if (problem) {
        return res.status(problem.rejection === 'too_large' ? 413 : 400).json({
          error: problem.message,
          reason: problem.rejection,
          file: problem.kind,
        });
      }

      if (!isStorageConfigured()) {
        const missingConfig = getMissingStorageConfigKeys();
        return res.status(503).json({
          error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
          missingConfig,
        });
      }

      const context = await loadExerciseForMedia(req, res, { requireStoragePrefix: true });
      if (!context) return;
      const { gymId, exercise } = context;
      const folderPrefix = context.folderPrefix as string;

      const imageKey = buildGymExerciseImageKey(folderPrefix, exercise.id, exercise.name);
      const thumbnailKey = buildGymExerciseImageThumbnailKey(folderPrefix, exercise.id, exercise.name);
      const imageUrl = buildStorageObjectUrl(imageKey);
      const thumbnailUrl = buildStorageObjectUrl(thumbnailKey);

      try {
        await ensureStorageFolders(gymExerciseImageFolderKeys(folderPrefix));
        await uploadStorageObject(imageKey, EXERCISE_IMAGE_MIME, image);
        await uploadStorageObject(thumbnailKey, EXERCISE_IMAGE_MIME, thumbnail);
      } catch (err: any) {
        const details = err instanceof StorageOperationError
          ? err.details
          : describeStorageError(err, { operation: 'uploadStorageObject', key: imageKey });
        logger.error(
          { err, details, diagnostics: getStorageDiagnostics(), gymId, exerciseId: exercise.id },
          'Cloudflare R2 exercise image upload failed',
        );
        // The row still points at whatever it pointed at before, so the previous
        // image stays exactly as it was — nothing was written (§8).
        return res.status(502).json({ error: `Failed to upload image: ${details.message}`, details });
      }

      await db.query(
        `UPDATE exercises SET image_url = ?, image_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND gym_id = ?`,
        [imageUrl, thumbnailUrl, await getCallerMembershipId(req), exercise.id, gymId],
      );

      await deleteReplacedExerciseMedia(
        gymId,
        folderPrefix,
        exercise.id,
        [exercise.image_url, exercise.image_thumbnail_url],
        // The video pair is kept as well as the new image pair: an exercise
        // whose poster happens to share an object with its old image must not
        // lose it because the image was replaced.
        [imageUrl, thumbnailUrl, exercise.video_url, exercise.video_thumbnail_url],
      );

      recordAudit(req, {
        action: 'update',
        entityType: 'exercise',
        entityId: exercise.id,
        previous: { image_url: exercise.image_url, image_thumbnail_url: exercise.image_thumbnail_url },
        next: { image_url: imageUrl, image_thumbnail_url: thumbnailUrl },
      });
      await respondWithExercise(req, res, gymId, exercise.id);
    } catch (err) { next(err); }
  },
);

/**
 * Clears a Gym Exercise's image (§10). The references go, the gym's own objects
 * are deleted, and a System object the exercise inherited at import time is
 * left alone. There is deliberately **no fallback** to the Base Exercise's
 * image afterwards — the exercise simply has none, and re-importing is the
 * supported way to get the System media back (§12).
 */
exercisesRouter.delete('/:id/image', requireModuleWrite('TRAINING'), async (req, res, next) => {
  try {
    const context = await loadExerciseForMedia(req, res, { requireStoragePrefix: false });
    if (!context) return;
    const { gymId, folderPrefix, exercise } = context;

    await db.query(
      `UPDATE exercises SET image_url = NULL, image_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND gym_id = ?`,
      [await getCallerMembershipId(req), exercise.id, gymId],
    );

    await deleteReplacedExerciseMedia(
      gymId,
      folderPrefix,
      exercise.id,
      [exercise.image_url, exercise.image_thumbnail_url],
      [exercise.video_url, exercise.video_thumbnail_url],
    );

    recordAudit(req, {
      action: 'update',
      entityType: 'exercise',
      entityId: exercise.id,
      previous: { image_url: exercise.image_url, image_thumbnail_url: exercise.image_thumbnail_url },
      next: { image_url: null, image_thumbnail_url: null },
    });
    await respondWithExercise(req, res, gymId, exercise.id);
  } catch (err) { next(err); }
});

/* ── Gym Exercise video (#719 part 2) ─────────────────────────────────────── */
//
// A Gym Exercise's video is an **MP4 plus a 512×512 poster** (§6, §7), both
// stored in the gym's own R2 folder under keys derived from the row:
// `<storage_folder_prefix>/Exercises/Videos/<id>-<Name>.mp4` and
// `…-thumbnail.png`. Everything part 1 established for images holds unchanged:
// the folder is the gym's own column, the exercise is looked up inside the
// tenant, and the key comes from the row — so nothing a client sends can reach
// another gym's folder or the platform's (§18).
//
// The **browser** captures the poster frame (the answer on #719 Q2: no `sharp`,
// no `ffmpeg` in the API image) and uploads both files in one JSON body with
// base64 members, because a failed poster must fail the whole upload rather than
// leave a video the UI has to download to draw a row (§7, §9). The server
// validates each file from its own bytes — the MP4's `ftyp` brand, its `moov`
// and its video sample entries (`domain/mp4Video.ts`), the poster's PNG
// signature and exact size — and never from the `Content-Type` header or the
// file name (§7).
//
// Nothing is uploaded and nothing is written until both pass, so an invalid
// upload cannot disturb the video already there (§9). The old objects are
// deleted only *after* the row points at the new ones, and only when they are
// the gym's own and no other exercise still references them (§19).

/** The path `exerciseVideoBodyParser` applies to, mounted in `app.ts`. */
export const EXERCISE_VIDEO_UPLOAD_PATH = /^\/exercises\/[^/]+\/video\/?$/;

/**
 * The body parser for `POST /exercises/:id/video`.
 *
 * Mounted **before** the global `express.json()`, whose 100 kB default an MP4
 * blows through long before the route is reached — the request would fail as a
 * bare 413 with no chance to say which file was too large or by how much. The
 * ceiling is the two file limits plus base64's ~4/3 overhead and a little JSON
 * scaffolding; it bounds the *request*, while `validateExerciseVideoPair()`
 * bounds each file and answers with the file's own name.
 *
 * `exerciseVideoMaxBytes()` is read once, here, at start-up — the parser's limit
 * is fixed at construction, so changing `EXERCISE_VIDEO_MAX_MB` needs a restart
 * to take effect on the request size (the per-file check re-reads it).
 */
export const exerciseVideoBodyParser = express.json({
  limit: Math.ceil((exerciseVideoMaxBytes() + EXERCISE_VIDEO_POSTER_MAX_BYTES) * 1.4),
});

exercisesRouter.post(
  '/:id/video',
  requireModuleWrite('TRAINING'),
  async (req, res, next) => {
    try {
      const video = decodeBase64File(req.body?.video);
      const poster = decodeBase64File(req.body?.poster);
      if (!video || !poster) {
        return res.status(400).json({
          error: 'Both `video` (the MP4) and `poster` (its 512×512 thumbnail) are required, base64-encoded.',
        });
      }
      const problem = validateExerciseVideoPair(video, poster);
      if (problem) {
        return res.status(problem.rejection === 'too_large' ? 413 : 400).json({
          error: problem.message,
          reason: problem.rejection,
          file: problem.kind,
        });
      }

      if (!isStorageConfigured()) {
        const missingConfig = getMissingStorageConfigKeys();
        return res.status(503).json({
          error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
          missingConfig,
        });
      }

      const context = await loadExerciseForMedia(req, res, { requireStoragePrefix: true, mediaLabel: 'videos' });
      if (!context) return;
      const { gymId, exercise } = context;
      const folderPrefix = context.folderPrefix as string;

      const videoKey = buildGymExerciseVideoKey(folderPrefix, exercise.id, exercise.name);
      const posterKey = buildGymExerciseVideoPosterKey(folderPrefix, exercise.id, exercise.name);
      const videoUrl = buildStorageObjectUrl(videoKey);
      const posterUrl = buildStorageObjectUrl(posterKey);

      try {
        await ensureStorageFolders(gymExerciseVideoFolderKeys(folderPrefix));
        await uploadStorageObject(videoKey, EXERCISE_VIDEO_MIME, video);
        await uploadStorageObject(posterKey, EXERCISE_VIDEO_POSTER_MIME, poster);
      } catch (err: any) {
        const details = err instanceof StorageOperationError
          ? err.details
          : describeStorageError(err, { operation: 'uploadStorageObject', key: videoKey });
        logger.error(
          { err, details, diagnostics: getStorageDiagnostics(), gymId, exerciseId: exercise.id },
          'Cloudflare R2 exercise video upload failed',
        );
        // The row still points at whatever it pointed at before, so the previous
        // video and poster stay exactly as they were — nothing was written (§9).
        return res.status(502).json({ error: `Failed to upload video: ${details.message}`, details });
      }

      await db.query(
        `UPDATE exercises SET video_url = ?, video_thumbnail_url = ?, modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ? AND gym_id = ?`,
        [videoUrl, posterUrl, await getCallerMembershipId(req), exercise.id, gymId],
      );

      await deleteReplacedExerciseMedia(
        gymId,
        folderPrefix,
        exercise.id,
        [exercise.video_url, exercise.video_thumbnail_url],
        // The image pair is kept as well as the new video pair: an exercise
        // whose image happens to share an object with its old poster must not
        // lose it because the video was replaced.
        [videoUrl, posterUrl, exercise.image_url, exercise.image_thumbnail_url],
      );

      recordAudit(req, {
        action: 'update',
        entityType: 'exercise',
        entityId: exercise.id,
        previous: { video_url: exercise.video_url, video_thumbnail_url: exercise.video_thumbnail_url },
        next: { video_url: videoUrl, video_thumbnail_url: posterUrl },
      });
      await respondWithExercise(req, res, gymId, exercise.id);
    } catch (err) { next(err); }
  },
);

/**
 * Clears a Gym Exercise's video (§10). Both references go, the gym's own objects
 * are deleted, and a System object the exercise inherited at import time is left
 * alone. There is deliberately **no fallback** to the Base Exercise's video
 * afterwards — the exercise simply has none, and re-importing is the supported
 * way to get the System media back (§12).
 */
exercisesRouter.delete('/:id/video', requireModuleWrite('TRAINING'), async (req, res, next) => {
  try {
    const context = await loadExerciseForMedia(req, res, { requireStoragePrefix: false, mediaLabel: 'videos' });
    if (!context) return;
    const { gymId, folderPrefix, exercise } = context;

    await db.query(
      `UPDATE exercises SET video_url = NULL, video_thumbnail_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
        WHERE id = ? AND gym_id = ?`,
      [await getCallerMembershipId(req), exercise.id, gymId],
    );

    await deleteReplacedExerciseMedia(
      gymId,
      folderPrefix,
      exercise.id,
      [exercise.video_url, exercise.video_thumbnail_url],
      [exercise.image_url, exercise.image_thumbnail_url],
    );

    recordAudit(req, {
      action: 'update',
      entityType: 'exercise',
      entityId: exercise.id,
      previous: { video_url: exercise.video_url, video_thumbnail_url: exercise.video_thumbnail_url },
      next: { video_url: null, video_thumbnail_url: null },
    });
    await respondWithExercise(req, res, gymId, exercise.id);
  } catch (err) { next(err); }
});
