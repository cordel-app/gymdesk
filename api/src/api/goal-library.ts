import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireFeatureWrite, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  GOAL_LIBRARY_AUDIT_ENTITIES,
  GOAL_LIBRARY_FEATURE_KEYS,
  GOAL_LIBRARY_TABLES,
  GOAL_LIBRARY_READ_SOURCES,
  GoalLibraryKind,
  buildGoalListWhere,
  goalKindHasWebpImage,
  goalKindIsTranslated,
  goalKindIsGymConfigurable,
  gymGoalStatusSql,
  isMeasurableGoalKind,
  normalizeGoalName,
} from '../domain/goalLibrary';
import {
  copyStorageObject,
  describeStorageError,
  ensureStorageFolders,
  isStorageConfigured,
  StorageOperationError,
  storageKeyFromObjectUrl,
} from '../infra/storage';
import { logger } from '../lib/logger';
import { BASE_LOCALE, SUPPORTED_LOCALES, TRANSLATABLE_LOCALES, getRequestLocale, SupportedLocale } from '../infra/locale';
import {
  goalTranslationsExpr,
  localizedGoalExprs,
  parseGoalTranslations,
  replaceGoalTranslations,
  withGoalTranslations,
  copyGoalTranslations,
  type TranslatedGoalKind,
} from '../domain/nutritionGoalTranslations';
import {
  GOAL_IMAGE_FOLDERS,
  buildNutritionGoalImageKey,
  buildNutritionGoalImageThumbnailKey,
  nutritionGoalImageFolderKeys,
} from '../domain/nutritionGoalImages';
import {
  clearNutritionGoalImage,
  migrateNutritionGoalImageOnRename,
  storeNutritionGoalImage,
} from './nutrition-goal-image-storage';
import {
  gymStorageFolderPrefix as memberGymStorageFolderPrefix,
  isMemberImageRefusal,
  memberImageBodyParser,
  memberImageUploadRateLimit,
  parseMemberImageRequest,
} from './member-image-storage';
// What a goal **target** is lives in one module, shared with the assignment side
// (#1034 §1 — "do not introduce a second, incompatible unit system").
import { normalizeTargetType, normalizeTargetUnit, normalizeTargetValue, targetPairError } from '../domain/goalTarget';
// The description rules and the actor columns are the Foods library's, reused
// rather than restated: a goal row carries the same `description` + the three
// plain-text `created_by`/`modified_by`/`deleted_by` columns (#1182), and
// `itemDetailColumnsSql` only ever names the alias it is given.
import {
  clampLimit, clampOffset, itemDetailColumnsSql, normalizeDescription,
} from '../domain/nutritionLibrary';
import { resolveRequestActor } from '../domain/auditActor';
import { importBasePersonalGoals, listBasePersonalGoalsForGym } from './gym-default-personal-goals';

/**
 * #947 — a gym's view of one goal catalogue (Personal Goals or Nutrition Goals).
 *
 * One factory serves both kinds because the two tables are identical in shape
 * (`api/src/domain/goalLibrary.ts` is what decides that); the kind decides the
 * table and the audit entity type and nothing else. Mounted twice in `app.ts`, at
 * `/personal-goals` and `/nutrition-goals`.
 *
 * Visibility is the Foods library's, unchanged (§5): the **System** rows
 * (`gym_id IS NULL`) are always listed and are read-only here — they are
 * administered from Cordel — and the gym's own rows are listed, editable and
 * deletable with write access. A gym may not touch a System row through this
 * router, and `/platform/*` is where those are administered.
 */
export function createGoalLibraryRouter(kind: GoalLibraryKind): Router {
  const router = Router();
  const table = GOAL_LIBRARY_TABLES[kind];
  // #1849 stage 2c: reads of the catalogue go through its read source (a view for Personal Goals).
  const readTable = GOAL_LIBRARY_READ_SOURCES[kind];
  const entityType = GOAL_LIBRARY_AUDIT_ENTITIES[kind];
  // #1034 §1: only a measurable kind has the pair, and `nutrition_goals` has no
  // such columns — projecting them there would answer ER_BAD_FIELD_ERROR, which
  // the global handler turns into a bare 500 (#966). `isMeasurableGoalKind()` is
  // the one place that decides it, asked here rather than branched on per route.
  const measurable = isMeasurableGoalKind(kind);
  // #1623: the WebP pair and the translated name/description, each one
  // declaration-rather-than-branch, like the two above.
  const hasWebpImage = goalKindHasWebpImage(kind);
  const translated = goalKindIsTranslated(kind);
  // #1181: the same declaration-rather-than-branch rule for the per-gym
  // availability state and the Duplicate: asked once, so `gym_status` is
  // projected and the three routes are registered only for a kind that has them.
  const configurable = goalKindIsGymConfigurable(kind);
  // #1070: writes are gated on this catalogue's own feature key rather than on
  // `NUTRITION` alone, so a feature-level override reaches exactly the catalogue
  // it was declared for. With no override declared the guard answers precisely
  // what `requireModuleWrite('NUTRITION')` did.
  const requireWrite = requireFeatureWrite(GOAL_LIBRARY_FEATURE_KEYS[kind], 'NUTRITION');

  /**
   * The columns every goal-shaped response returns, declared once so this router
   * and the platform one cannot answer with different shapes (#799 §26).
   *
   * `maskPlatformActors`: this router also returns the System rows, which are
   * administered from Cordel — so their actor names are Cordel employees' and are
   * not published to every tenant. A gym's own rows carry theirs.
   */
  const columnsFor = (locale: SupportedLocale) => `g.id, g.gym_id, g.slug, g.name, g.status,${measurable ? ' g.target_value, g.target_unit, g.target_type,' : ''}${hasWebpImage ? ' g.image_url, g.image_thumbnail_url,' : ''}${translated ? ` ${localizedGoalExprs('g', locale, kind as TranslatedGoalKind)}, ${goalTranslationsExpr('g', 'translations', kind as TranslatedGoalKind)},` : ''}${configurable ? ` ${gymGoalStatusSql('g')} AS gym_status,` : ''}${kind === 'personal' ? ' g.base_personal_goal_id, (g.gym_id IS NULL OR g.base_personal_goal_id IS NOT NULL) AS is_system,' : ''}
    g.created_at, g.modified_at,
    ${itemDetailColumnsSql('g', { maskPlatformActors: true })}`;
  /** The parameters `COLUMNS` binds before a query's own — the gym of `gym_status`, for a configurable kind. */
  const columnParams = (gymId: string): unknown[] => (configurable ? [gymId] : []);

  /**
   * `target_value` is a DECIMAL, which mysql2 hands back as a string. Every
   * other number this API reports is a number (CLAUDE.md's rule for
   * `shapeProductBenefitRow()`), so the conversion happens once, here, rather
   * than in whichever page renders it. A non-measurable kind has no such key and
   * the row passes through untouched.
   */
  function shapeGoal<T extends Record<string, unknown>>(input: T) {
    // #1623: `translations` is `{}` rather than NULL for a goal with none.
    const withTranslations = translated ? withGoalTranslations(input as any) as T : input;
    // #1850: a System row, or a gym's copy of a Base Personal Goal, reads as system-origin.
    const row = withTranslations && 'is_system' in withTranslations
      ? { ...withTranslations, is_system: Boolean(withTranslations.is_system) } as T
      : withTranslations;
    if (!row || !measurable) return row;
    return {
      ...row,
      target_value: row.target_value === null || row.target_value === undefined
        ? null
        : Number(row.target_value),
    };
  }

  async function loadGoal(id: unknown, gymId: string, locale: SupportedLocale = BASE_LOCALE) {
    const { rows } = await db.query(`SELECT ${columnsFor(locale)} FROM ${readTable} g WHERE g.id = ?`, [...columnParams(gymId), id]);
    return rows[0] ? shapeGoal(rows[0]) : undefined;
  }

  /**
   * The submitted target pair, or the 400 that describes it. Answered for a
   * measurable kind only: a request that names a target on a Nutrition Goal is
   * ignored rather than refused, exactly as a submitted `slug` is — there is no
   * column for it, and the field is not part of that kind's contract.
   */
  function readTarget(body: any): { value: { value: number | null | undefined; unit: string | null | undefined; type: 'absolute' | 'relative' | undefined } } | { error: string } {
    if (!measurable) return { value: { value: undefined, unit: undefined, type: undefined } };
    const value = normalizeTargetValue(body?.target_value, { allowNegative: true });
    if ('error' in value) return { error: value.error };
    const type = normalizeTargetType(body?.target_type);
    if ('error' in type) return { error: type.error };
    const unit = normalizeTargetUnit(body?.target_unit);
    if ('error' in unit) return { error: unit.error };
    return { value: { value: value.value, unit: unit.value, type: type.value } };
  }

  /* ── Supported locales (#1623) ──────────────────────────────────────────── */
  // Lets the editor render one name/description pair per translatable locale
  // instead of keeping the list a second time in the frontend. Registered only
  // for a translated kind, and before any `/:id` route.
  if (translated) {
    router.get('/locales', (_req, res) => {
      res.json({ locales: SUPPORTED_LOCALES, base_locale: BASE_LOCALE, translatable: TRANSLATABLE_LOCALES });
    });
  }

  /* ── List ───────────────────────────────────────────────────────────────── */

  router.get('/', async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const { where, params } = buildGoalListWhere(
      req.query.search,
      ['(g.gym_id IS NULL OR g.gym_id = ?)', "g.status != 'deleted'"],
      [gymId],
      { searchTranslations: translated, translationKind: kind as TranslatedGoalKind },
    );
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);

    try {
      const { rows: countRows } = await db.query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${readTable} g WHERE ${where}`,
        params,
      );
      // LIMIT/OFFSET must be literals, not `?` parameters: MySQL 8's
      // prepared-statement protocol rejects a parameterised LIMIT
      // (ER_WRONG_ARGUMENTS). Both are already validated integers.
      //
      // Ordered by the stored `name`, not by what the viewer reads: a seeded
      // System row's label is a locale key the admin resolves, so there is no
      // localized column to sort on (which is what the Foods library's
      // `display_name` is). The base names are the English ones the slugs were
      // seeded with, so the order is stable rather than per-request.
      const { rows } = await db.query(
        `SELECT ${columnsFor(getRequestLocale(req))} FROM ${readTable} g WHERE ${where} ORDER BY g.name ASC LIMIT ${limit} OFFSET ${offset}`,
        [...columnParams(gymId), ...params],
      );
      res.json({ items: rows.map(shapeGoal), total: countRows[0]?.total ?? 0, limit, offset });
    } catch (err) { next(err); }
  });

  /* ── Create (gym-owned goals only) ──────────────────────────────────────── */

  router.post('/', requireWrite, async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const name = normalizeGoalName(req.body?.name, { required: true });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const target = readTarget(req.body);
    if ('error' in target) return res.status(400).json({ error: target.error });
    const goalTranslations = translated ? parseGoalTranslations(req.body) : {};
    if (goalTranslations.error) return res.status(400).json({ error: goalTranslations.error });
    // On a create an unmentioned field is simply empty, so the cross-field rule
    // is applied to exactly what will be stored.
    const pairError = targetPairError({
      targetValue: target.value.value ?? null,
      targetUnit: target.value.unit ?? null,
      targetType: target.value.type ?? 'absolute',
    });
    if (pairError) return res.status(400).json({ error: pairError });
    const actor = resolveRequestActor(getTenantContext(req));

    try {
      // Scoped to this gym's own rows: a System goal called "Water" must not stop
      // a gym from naming one of its own the same way, which is also what the
      // (gym, name) shape of `<prefix>_live_name_key` allows.
      const { rows: existing } = await db.query(
        `SELECT id FROM ${readTable} WHERE gym_id = ? AND name = ? AND status != 'deleted'`,
        [gymId, name.value],
      );
      if (existing.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });

      // `slug` is deliberately not written: it is a System row's label handle and
      // `chk_<prefix>_slug_system_only` refuses one on a gym row.
      const insertId = await db.transaction(async (tx) => {
        const { insertId: goalId } = await tx.query(
          `INSERT INTO ${table} (gym_id, name, description,${measurable ? ' target_value, target_unit, target_type,' : ''}
             status, created_by)
           VALUES (?, ?, ?,${measurable ? ' ?, ?, ?,' : ''} 'active', ?)`,
          [
            gymId, name.value, description.value ?? null,
            ...(measurable ? [target.value.value ?? null, target.value.unit ?? null, target.value.type ?? 'absolute'] : []),
            actor,
          ],
        );
        // #1181 — a gym's own goal starts available to that gym, explicitly.
        if (configurable) await writeGymGoalStatus(tx, gymId, goalId, 'active', actor);
        // #1623 — the translated name and description commit with the goal.
        if (goalTranslations.translations) await replaceGoalTranslations(tx, goalId, goalTranslations.translations, kind as TranslatedGoalKind);
        return goalId as number;
      });
      const goal = await loadGoal(insertId, gymId, getRequestLocale(req));
      recordAudit(req, { action: 'create', entityType, entityId: insertId, next: goal });
      res.status(201).json(goal);
    } catch (err) { next(err); }
  });

  /* ── Update (gym-owned goals only — System goals are read-only here) ────── */

  router.put('/:id', requireWrite, async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const { id } = req.params;
    const name = normalizeGoalName(req.body?.name, { required: false });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const target = readTarget(req.body);
    if ('error' in target) return res.status(400).json({ error: target.error });
    const goalTranslations = translated ? parseGoalTranslations(req.body) : {};
    if (goalTranslations.error) return res.status(400).json({ error: goalTranslations.error });
    const actor = resolveRequestActor(getTenantContext(req));

    try {
      const { rows: existing } = await db.query(
        `SELECT id, gym_id, name, description, status${hasWebpImage ? ', image_url, image_thumbnail_url' : ''}${measurable ? ', target_value, target_unit, target_type' : ''}
         FROM ${readTable} WHERE id = ?`,
        [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].gym_id === null) return res.status(403).json({ error: 'System goals are read-only' });
      if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Goal is deleted' });

      if (name.value !== undefined) {
        const { rows: conflict } = await db.query(
          `SELECT id FROM ${readTable} WHERE gym_id = ? AND name = ? AND id != ? AND status != 'deleted'`,
          [gymId, name.value, id],
        );
        if (conflict.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });
      }

      // The actor moves with every edit, so `modified_by` always names
      // whoever `modified_at` refers to (#799 §13).
      const updates = ['modified_at = UTC_TIMESTAMP()', 'modified_by = ?'];
      const params: unknown[] = [actor];
      if (name.value !== undefined) { updates.push('name = ?'); params.push(name.value); }
      // Absent from the body means "leave it alone"; an empty string means "clear it".
      if (description.value !== undefined) { updates.push('description = ?'); params.push(description.value); }
      if (measurable) {
        // Checked against the row the write produces, not against the body:
        // clearing `target_value` while a stored `target_unit` stays behind is
        // exactly the case a per-field check misses, and the CHECK beside the
        // table would answer it as a driver error rather than the 400 it is.
        const pairError = targetPairError({
          targetValue: target.value.value === undefined
            ? toNumberOrNull(existing[0].target_value) : target.value.value,
          targetUnit: target.value.unit === undefined
            ? (existing[0].target_unit ?? null) : target.value.unit,
          targetType: target.value.type ?? (existing[0].target_type === 'relative' ? 'relative' : 'absolute'),
        });
        if (pairError) return res.status(400).json({ error: pairError });
        if (target.value.value !== undefined) { updates.push('target_value = ?'); params.push(target.value.value); }
        if (target.value.unit !== undefined) { updates.push('target_unit = ?'); params.push(target.value.unit); }
        if (target.value.type !== undefined) { updates.push('target_type = ?'); params.push(target.value.type); }
      }
      params.push(id);
      await db.transaction(async (tx) => {
        await tx.query(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = ?`, params);
        if (goalTranslations.translations) await replaceGoalTranslations(tx, String(id), goalTranslations.translations, kind as TranslatedGoalKind);
      });

      // #1623: the image key carries the goal's name, so a rename moves it.
      if (hasWebpImage && name.value !== undefined && name.value !== existing[0].name && existing[0].image_url) {
        await migrateNutritionGoalImageOnRename(
          { gymId, prefix: await memberGymStorageFolderPrefix(gymId), kind },
          {
            id: existing[0].id, name: name.value,
            image_url: existing[0].image_url, image_thumbnail_url: existing[0].image_thumbnail_url ?? null,
          },
        );
      }

      const goal = await loadGoal(id, gymId, getRequestLocale(req));
      recordAudit(req, {
        action: 'update', entityType, entityId: id,
        previous: shapeGoal(existing[0]), next: goal,
      });
      res.json(goal);
    } catch (err) { next(err); }
  });


  /* ── Image (#1623, #1722 — a goal's own artwork, WebP master + thumbnail) ── */
  //
  // The Membership Plan's pipeline one entity over: the server makes both files
  // from the one original the client sends. The route takes neither the folder
  // nor the key from the request: the prefix is the gym's own column, the goal is
  // looked up inside the tenant and the key is built from the row's id and name.
  if (hasWebpImage) {
    /** The gym-owned goal this request is about, or the response that says why there is none. */
    async function loadNutritionGoalForImage(req: any, res: any, requirePrefix: boolean) {
      const { gymId } = getTenantContext(req);
      const { rows } = await db.query<{ id: number; gym_id: string | null; name: string; status: string; image_url: string | null; image_thumbnail_url: string | null }>(
        `SELECT id, gym_id, name, status, image_url, image_thumbnail_url FROM ${readTable} WHERE id = ?`,
        [req.params.id],
      );
      const row = rows[0];
      if (row && row.gym_id === null) { res.status(403).json({ error: 'System goals are read-only' }); return null; }
      if (!row || row.gym_id !== gymId) { res.status(404).json({ error: 'Goal not found' }); return null; }
      if (row.status === 'deleted') { res.status(409).json({ error: 'Goal is deleted' }); return null; }
      const prefix = await memberGymStorageFolderPrefix(gymId);
      if (!prefix && requirePrefix) {
        res.status(409).json({
          error: 'Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.',
        });
        return null;
      }
      return {
        gymId, prefix,
        goal: { id: row.id, name: row.name, image_url: row.image_url, image_thumbnail_url: row.image_thumbnail_url },
      };
    }

    router.post('/:id/image', requireWrite, memberImageUploadRateLimit, memberImageBodyParser, async (req, res, next) => {
      try {
        const parsed = await parseMemberImageRequest(req);
        if (isMemberImageRefusal(parsed)) return res.status(parsed.status).json(parsed.body);
        const context = await loadNutritionGoalForImage(req, res, true);
        if (!context) return;
        const { gymId, goal } = context;
        const stored = await storeNutritionGoalImage({
          scope: { gymId, prefix: context.prefix as string, kind },
          goal, images: parsed,
          modifiedBy: resolveRequestActor(getTenantContext(req)),
        });
        if (isMemberImageRefusal(stored)) return res.status(stored.status).json(stored.body);
        recordAudit(req, {
          action: 'update', entityType, entityId: goal.id,
          previous: { image_url: goal.image_url }, next: { image_url: stored.image_url },
        });
        res.json(await loadGoal(goal.id, gymId, getRequestLocale(req)));
      } catch (err) { next(err); }
    });

    /** Clears a gym goal's image; there is no fallback to a System goal's image afterwards. */
    router.delete('/:id/image', requireWrite, async (req, res, next) => {
      try {
        const context = await loadNutritionGoalForImage(req, res, false);
        if (!context) return;
        const { gymId, prefix, goal } = context;
        await clearNutritionGoalImage({
          scope: { gymId, prefix, kind }, goal,
          modifiedBy: resolveRequestActor(getTenantContext(req)),
        });
        recordAudit(req, {
          action: 'update', entityType, entityId: goal.id,
          previous: { image_url: goal.image_url }, next: { image_url: null },
        });
        res.json(await loadGoal(goal.id, gymId, getRequestLocale(req)));
      } catch (err) { next(err); }
    });
  }

  /* ── Per-gym availability and Duplicate (#1181) ─────────────────────────── */
  //
  // Registered only for a kind a gym configures (`goalKindIsGymConfigurable()`),
  // so a Nutrition Goal's `/:id/activate` is a 404 rather than a write to a
  // table that does not exist for it.

  /**
   * The one writer of `gym_personal_goals`: an upsert keyed on the UNIQUE
   * `(gym_id, personal_goal_id)`, so activating and deactivating are idempotent
   * and never touch the goal's own row — a System goal's definition is shared
   * by every gym and is not this gym's to change (the ticket's architectural
   * requirement, and `gym_professional_services`' pattern).
   */
  async function writeGymGoalStatus(
    q: { query: typeof db.query },
    gymId: string,
    goalId: number | string,
    status: 'active' | 'inactive',
    actor: string | null,
  ): Promise<void> {
    await q.query(
      `INSERT INTO gym_personal_goals (gym_id, personal_goal_id, base_personal_goal_id, status, created_by)
       VALUES (?, (SELECT id FROM personal_goals WHERE id = ? AND gym_id IS NOT NULL), (SELECT id FROM base_personal_goals WHERE id = ?), ?, ?) AS incoming
       ON DUPLICATE KEY UPDATE
         status = incoming.status,
         modified_at = UTC_TIMESTAMP(),
         modified_by = incoming.created_by`,
      [gymId, goalId, goalId, status, actor],
    );
  }

  /** A goal the gym can see — a System one or its own — and the 404/409 when it cannot. */
  async function loadVisibleGoal(req: any, res: any) {
    const { gymId } = getTenantContext(req);
    const { rows } = await db.query(
      `SELECT id, gym_id, name, description, status${measurable ? ', target_value, target_unit, target_type' : ''}${hasWebpImage ? ', image_url, image_thumbnail_url' : ''}
       FROM ${readTable} WHERE id = ? AND (gym_id IS NULL OR gym_id = ?)`,
      [req.params.id, gymId],
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Goal not found' }); return null; }
    if (rows[0].status === 'deleted') { res.status(409).json({ error: 'Goal is deleted' }); return null; }
    return rows[0];
  }

  if (configurable) {
    // ─── #1850 — Import System Personal Goals ─────────────────────────────────
    // `GET /base` reads the global `base_personal_goals` templates with this
    // gym's import state; `POST /import` creates gym-owned goals from the chosen
    // ones. Never an UPDATE of a goal the gym already has (a re-import skips it).
    router.get('/base', requireRole('admin'), async (req, res, next) => {
      const { gymId } = getTenantContext(req);
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      try {
        const rows = await listBasePersonalGoalsForGym(gymId, q || undefined);
        res.json(rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          target_value: r.target_value === null ? null : Number(r.target_value),
          target_unit: r.target_unit,
          target_type: r.target_type,
          imported: r.imported,
          imported_personal_goal_id: r.imported_personal_goal_id,
        })));
      } catch (err) { next(err); }
    });

    router.post('/import', requireRole('admin'), requireWrite, async (req, res, next) => {
      const ctx = getTenantContext(req);
      const ids = req.body?.base_personal_goal_ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200
        || !ids.every((v: unknown) => Number.isInteger(v) && (v as number) > 0)) {
        return res.status(400).json({ error: 'base_personal_goal_ids must be a non-empty array of positive integers' });
      }
      try {
        const result = await importBasePersonalGoals(ctx.gymId, [...new Set<number>(ids)], resolveRequestActor(ctx));
        for (const baseId of result.imported) {
          recordAudit(req, {
            action: 'create', entityType, entityName: 'Import System Personal Goal',
            next: { base_personal_goal_id: baseId },
          });
        }
        res.json(result);
      } catch (err) { next(err); }
    });

    for (const [action, status] of [['activate', 'active'], ['deactivate', 'inactive']] as const) {
      router.post(`/:id/${action}`, requireWrite, async (req, res, next) => {
        const { gymId } = getTenantContext(req);
        const actor = resolveRequestActor(getTenantContext(req));
        try {
          const source = await loadVisibleGoal(req, res);
          if (!source) return;
          const before = await loadGoal(source.id, gymId);
          await writeGymGoalStatus(db, gymId, source.id, status, actor);
          const goal = await loadGoal(source.id, gymId);
          // For a System goal this is a gym-level configuration change, not an
          // edit of the definition: the entity is still the goal (so the Audit
          // Log's filter finds it), the gym and actor are the request's, and
          // what moved is the gym's own state.
          recordAudit(req, {
            action, entityType, entityId: source.id, entityName: source.name,
            previous: { gym_status: before?.gym_status ?? null }, next: { gym_status: goal?.gym_status ?? null },
          });
          res.json(goal);
        } catch (err) { next(err); }
      });
    }

    /**
     * Copies the source goal's image objects (master and thumbnail) into the
     * gym's own keys for the new goal — never a shared reference: the key
     * carries the goal's id, so two goals cannot point at one object, and a
     * System image under `cordel/goals/` is read and never written (#1041's rule
     * for cloning a Theme's assets). A pre-#1722 PNG master is copied under its
     * own extension (it has no thumbnail), so the copy never claims to be WebP;
     * a URL that is not an object of this bucket is carried over as the
     * reference it is. Best-effort: a failed copy leaves the duplicate with no
     * image and an error in the log, never a half-created goal.
     */
    async function copyGoalImagesForDuplicate(
      gymId: string,
      source: { image_url: string; image_thumbnail_url: string | null },
      goalId: number,
      goalName: string,
    ): Promise<{ image_url: string; image_thumbnail_url: string | null } | null> {
      const sourceKey = storageKeyFromObjectUrl(source.image_url);
      if (!sourceKey) return { image_url: source.image_url, image_thumbnail_url: source.image_thumbnail_url };
      if (!isStorageConfigured()) return null;
      const folderPrefix = await memberGymStorageFolderPrefix(gymId);
      if (!folderPrefix) return null;
      const folder = GOAL_IMAGE_FOLDERS[kind];
      const isWebp = sourceKey.endsWith('.webp');
      const destKey = isWebp
        ? buildNutritionGoalImageKey(folderPrefix, goalId, goalName, folder)
        : buildNutritionGoalImageKey(folderPrefix, goalId, goalName, folder).replace(/\.webp$/, sourceKey.slice(sourceKey.lastIndexOf('.')));
      const thumbSourceKey = isWebp && source.image_thumbnail_url ? storageKeyFromObjectUrl(source.image_thumbnail_url) : null;
      const destThumbKey = thumbSourceKey ? buildNutritionGoalImageThumbnailKey(folderPrefix, goalId, goalName, folder) : null;
      try {
        await ensureStorageFolders(nutritionGoalImageFolderKeys(folderPrefix, folder));
        const imageUrl = await copyStorageObject(sourceKey, destKey);
        const thumbUrl = thumbSourceKey && destThumbKey ? await copyStorageObject(thumbSourceKey, destThumbKey) : null;
        return { image_url: imageUrl, image_thumbnail_url: thumbUrl };
      } catch (err: any) {
        const details = err instanceof StorageOperationError
          ? err.details
          : describeStorageError(err, { operation: 'copyStorageObject', key: destKey });
        logger.error({ err, details, gymId, goalId, sourceKey }, 'Duplicating a goal could not copy its image');
        return null;
      }
    }

    router.post('/:id/duplicate', requireWrite, async (req, res, next) => {
      const { gymId } = getTenantContext(req);
      const actor = resolveRequestActor(getTenantContext(req));
      try {
        const source = await loadVisibleGoal(req, res);
        if (!source) return;
        // The Professional Services convention, and a 409 on a second copy
        // rather than a silently numbered name.
        const newName = `${source.name} - Copy`;
        const { rows: existing } = await db.query(
          `SELECT id FROM ${readTable} WHERE gym_id = ? AND name = ? AND status != 'deleted'`,
          [gymId, newName],
        );
        if (existing.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });

        // The definition fields and nothing else: no slug (a System row's label
        // handle), no source ownership, no actors, no image yet — the object is
        // copied once the row has the id its key is built from.
        const insertId = await db.transaction(async (tx) => {
          const { insertId: goalId } = await tx.query(
            `INSERT INTO ${table} (gym_id, name, description,${measurable ? ' target_value, target_unit, target_type,' : ''}
               status, created_by)
             VALUES (?, ?, ?,${measurable ? ' ?, ?, ?,' : ''} 'active', ?)`,
            [
              gymId, newName, source.description ?? null,
              ...(measurable ? [source.target_value ?? null, source.target_unit ?? null, source.target_type ?? 'absolute'] : []),
              actor,
            ],
          );
          await writeGymGoalStatus(tx, gymId, goalId, 'active', actor);
          // #1719 — translations travel with the text they translate.
          if (translated) await copyGoalTranslations(tx, source.id, goalId, kind as TranslatedGoalKind);
          return goalId as number;
        });

        if (hasWebpImage && source.image_url) {
          const copied = await copyGoalImagesForDuplicate(gymId, source, insertId, newName);
          if (copied) {
            await db.query(
              `UPDATE ${table} SET image_url = ?, image_thumbnail_url = ? WHERE id = ? AND gym_id = ?`,
              [copied.image_url, copied.image_thumbnail_url, insertId, gymId],
            );
          }
        }

        const goal = await loadGoal(insertId, gymId);
        recordAudit(req, {
          action: 'duplicate', entityType, entityId: insertId, entityName: newName,
          previous: { source_id: source.id, source_gym_id: source.gym_id }, next: goal,
        });
        res.status(201).json(goal);
      } catch (err) { next(err); }
    });
  }

  /* ── Soft delete (gym-owned goals only) ─────────────────────────────────── */

  router.delete('/:id', requireWrite, async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const { id } = req.params;
    const actor = resolveRequestActor(getTenantContext(req));

    try {
      const { rows: existing } = await db.query(
        `SELECT id, gym_id, status FROM ${readTable} WHERE id = ?`,
        [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].gym_id === null) return res.status(403).json({ error: 'System goals are read-only' });
      if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Goal is already deleted' });

      // `status = 'deleted'` stays the flag every query filters on; `deleted_at`
      // and the actor pair record when and by whom (#799 §13). The deletion also
      // releases the name: `<prefix>_live_name_key` is NULL for a deleted row.
      await db.query(
        `UPDATE ${table}
         SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by = ?,
             modified_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [actor, id],
      );
      recordAudit(req, { action: 'delete', entityType, entityId: id, previous: existing[0] });
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}

export const personalGoalsRouter = createGoalLibraryRouter('personal');
export const nutritionGoalsRouter = createGoalLibraryRouter('nutrition');

/** A DECIMAL the driver handed back as a string, as the number it is. */
function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
