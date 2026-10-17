import { Router } from 'express';
import { db } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  GOAL_LIBRARY_AUDIT_ENTITIES,
  GOAL_LIBRARY_TABLES,
  GoalLibraryKind,
  buildGoalListWhere,
  goalKindHasWebpImage,
  goalKindIsTranslated,
  isMeasurableGoalKind,
  normalizeGoalName,
} from '../domain/goalLibrary';
import { logger } from '../lib/logger';
import { BASE_LOCALE, SUPPORTED_LOCALES, TRANSLATABLE_LOCALES, getRequestLocale, SupportedLocale } from '../infra/locale';
import { PLATFORM_STORAGE_ROOT } from '../infra/storage';
import {
  goalTranslationsExpr,
  localizedGoalExprs,
  parseGoalTranslations,
  replaceGoalTranslations,
  withGoalTranslations,
} from '../domain/nutritionGoalTranslations';
import {
  clearNutritionGoalImage,
  migrateNutritionGoalImageOnRename,
  storeNutritionGoalImage,
} from './nutrition-goal-image-storage';
import {
  isMemberImageRefusal,
  memberImageBodyParser,
  memberImageUploadRateLimit,
  parseMemberImageRequest,
} from './member-image-storage';
// What a goal **target** is lives in one module, shared with the gym-facing
// router and the assignment side (#1034 §1).
import { normalizeTargetType, normalizeTargetUnit, normalizeTargetValue, targetPairError } from '../domain/goalTarget';
import {
  clampLimit, clampOffset, itemDetailColumnsSql, normalizeDescription,
} from '../domain/nutritionLibrary';
import { resolvePlatformActor } from '../domain/auditActor';

/**
 * #947 — Cordel's view of one goal catalogue: the **System** rows (`gym_id IS
 * NULL`) of `personal_goals` / `nutrition_goals`, which this router is the only
 * writer of. A gym's own goal is never visible or writable here, and the
 * gym-facing router answers 403 for a System one — each side answers for its own
 * rows only, the way the two Exercise routers do (#716/#717).
 *
 * Mounted twice in `app.ts`, at `/platform/personal-goals` and
 * `/platform/nutrition-goals`, both behind `requireSuperadmin`.
 */
export function createPlatformGoalLibraryRouter(kind: GoalLibraryKind): Router {
  const router = Router();
  const table = GOAL_LIBRARY_TABLES[kind];
  const entityType = GOAL_LIBRARY_AUDIT_ENTITIES[kind];
  // #1034 §1: only a measurable kind has `target_value`/`target_unit`, and
  // `nutrition_goals` has no such columns. Decided once, by the same declaration
  // the gym-facing router asks.
  const measurable = isMeasurableGoalKind(kind);
  // #1623: the WebP pair and the translated name/description (one declaration each).
  const hasWebpImage = goalKindHasWebpImage(kind);
  const translated = goalKindIsTranslated(kind);

  const columnsFor = (locale: SupportedLocale) => `g.id, g.gym_id, g.slug, g.name, g.status,${measurable ? ' g.target_value, g.target_unit, g.target_type,' : ''}${hasWebpImage ? ' g.image_url, g.image_thumbnail_url,' : ''}${translated ? ` ${localizedGoalExprs('g', locale)}, ${goalTranslationsExpr('g')},` : ''}
    g.created_at, g.modified_at,
    ${itemDetailColumnsSql('g')}`;

  /** A DECIMAL comes back from mysql2 as a string; reported as the number it is. */
  function shapeGoal<T extends Record<string, unknown>>(input: T) {
    const row = translated ? withGoalTranslations(input as any) as T : input;
    if (!row || !measurable) return row;
    return {
      ...row,
      target_value: row.target_value === null || row.target_value === undefined
        ? null
        : Number(row.target_value),
    };
  }

  /** The submitted target pair, or the 400 that describes it (measurable kinds only). */
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

  /**
   * Every write here is a superadmin's, by `requireSuperadmin` — the actor is
   * the superadmin's own name (#1182).
   */
  function platformActor(req: { superadminName?: string | null }) {
    return resolvePlatformActor(req.superadminName);
  }

  async function loadGoal(id: unknown, locale: SupportedLocale = BASE_LOCALE) {
    const { rows } = await db.query(`SELECT ${columnsFor(locale)} FROM ${table} g WHERE g.id = ?`, [id]);
    return rows[0] ? shapeGoal(rows[0]) : undefined;
  }

  /* ── Supported locales (#1623) ──────────────────────────────────────────── */
  // Lets the editor render one name/description pair per translatable locale
  // instead of keeping the list a second time in the frontend. Registered only
  // for a translated kind, and before any `/:id` route.
  if (translated) {
    router.get('/locales', requireSuperadmin, (_req, res) => {
      res.json({ locales: SUPPORTED_LOCALES, base_locale: BASE_LOCALE, translatable: TRANSLATABLE_LOCALES });
    });
  }

  /* ── List ───────────────────────────────────────────────────────────────── */

  router.get('/', requireSuperadmin, async (req, res, next) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const { where, params } = buildGoalListWhere(
      req.query.search,
      ['g.gym_id IS NULL', status ? 'g.status = ?' : "g.status != 'deleted'"],
      status ? [status] : [],
      { searchTranslations: translated },
    );
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);

    try {
      const { rows: countRows } = await db.query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${table} g WHERE ${where}`,
        params,
      );
      // Ordered by the stored `name`, not by what the viewer reads: a seeded
      // System row's label is a locale key the admin resolves, so there is no
      // localized column to sort on (which is what the Foods library's
      // `display_name` is). LIMIT/OFFSET are interpolated because MySQL 8
      // rejects a parameterised LIMIT; both are already validated integers.
      const { rows } = await db.query(
        `SELECT ${columnsFor(getRequestLocale(req))} FROM ${table} g WHERE ${where} ORDER BY g.name ASC LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      res.json({ items: rows.map(shapeGoal), total: countRows[0]?.total ?? 0, limit, offset });
    } catch (err) { next(err); }
  });

  /* ── Create ─────────────────────────────────────────────────────────────── */

  router.post('/', requireSuperadmin, async (req, res, next) => {
    const name = normalizeGoalName(req.body?.name, { required: true });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const target = readTarget(req.body);
    if ('error' in target) return res.status(400).json({ error: target.error });
    const createPairError = targetPairError({
      targetValue: target.value.value ?? null,
      targetUnit: target.value.unit ?? null,
      targetType: target.value.type ?? 'absolute',
    });
    if (createPairError) return res.status(400).json({ error: createPairError });
    const goalTranslations = translated ? parseGoalTranslations(req.body) : {};
    if (goalTranslations.error) return res.status(400).json({ error: goalTranslations.error });

    try {
      const { rows: existing } = await db.query(
        `SELECT id FROM ${table} WHERE gym_id IS NULL AND name = ? AND status != 'deleted'`,
        [name.value],
      );
      if (existing.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });

      // No `slug`: the slugs are migration 206's seeded handles for the locale
      // keys the admin resolves, and a System goal added later carries the single
      // name entered here (shown in every locale), exactly as a gym's own does.
      // Inventing a slug for it would promise a translation key nothing holds.
      const actor = platformActor(req);
      const insertId = await db.transaction(async (tx) => {
        const { insertId: goalId } = await tx.query(
          `INSERT INTO ${table} (gym_id, name, description,${measurable ? ' target_value, target_unit, target_type,' : ''}
             status, created_by)
           VALUES (NULL, ?, ?,${measurable ? ' ?, ?, ?,' : ''} 'active', ?)`,
          [
            name.value, description.value ?? null,
            ...(measurable ? [target.value.value ?? null, target.value.unit ?? null, target.value.type ?? 'absolute'] : []),
            actor,
          ],
        );
        // #1623 — the translated name and description commit with the goal.
        if (goalTranslations.translations) await replaceGoalTranslations(tx, goalId, goalTranslations.translations);
        return goalId as number;
      });
      const goal = await loadGoal(insertId, getRequestLocale(req));
      recordAudit(req, { action: 'create', entityType, entityId: insertId, next: goal });
      res.status(201).json(goal);
    } catch (err) { next(err); }
  });

  /* ── Update ─────────────────────────────────────────────────────────────── */

  router.put('/:id', requireSuperadmin, async (req, res, next) => {
    const { id } = req.params;
    const name = normalizeGoalName(req.body?.name, { required: false });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const target = readTarget(req.body);
    if ('error' in target) return res.status(400).json({ error: target.error });
    const goalTranslations = translated ? parseGoalTranslations(req.body) : {};
    if (goalTranslations.error) return res.status(400).json({ error: goalTranslations.error });

    try {
      const { rows: existing } = await db.query(
        `SELECT id, name, description, status, slug${hasWebpImage ? ', image_url, image_thumbnail_url' : ''}${measurable ? ', target_value, target_unit, target_type' : ''}
         FROM ${table} WHERE id = ? AND gym_id IS NULL`,
        [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Goal is deleted' });

      if (name.value !== undefined) {
        const { rows: conflict } = await db.query(
          `SELECT id FROM ${table} WHERE gym_id IS NULL AND name = ? AND id != ? AND status != 'deleted'`,
          [name.value, id],
        );
        if (conflict.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });
      }

      // `slug` is not writable: it is the handle the admin's locale key is built
      // from, so renaming one would silently move a seeded goal's label to the
      // key's verbatim text. The displayed name is `name`, which is editable.
      const updates = ['modified_at = UTC_TIMESTAMP()', 'modified_by = ?'];
      const actor = platformActor(req);
      const params: unknown[] = [actor];
      if (name.value !== undefined) { updates.push('name = ?'); params.push(name.value); }
      if (description.value !== undefined) { updates.push('description = ?'); params.push(description.value); }
      if (measurable) {
        // Against the row the write produces, not against the body: clearing the
        // value while a stored unit stays behind is what a per-field check misses.
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
        if (goalTranslations.translations) await replaceGoalTranslations(tx, String(id), goalTranslations.translations);
      });

      // #1623: the image key carries the goal's name, so a rename moves it.
      if (hasWebpImage && name.value !== undefined && name.value !== existing[0].name && existing[0].image_url) {
        await migrateNutritionGoalImageOnRename(
          { gymId: null, prefix: PLATFORM_STORAGE_ROOT, kind },
          {
            id: existing[0].id, name: name.value,
            image_url: existing[0].image_url, image_thumbnail_url: existing[0].image_thumbnail_url ?? null,
          },
        );
      }

      const goal = await loadGoal(id, getRequestLocale(req));
      recordAudit(req, {
        action: 'update', entityType, entityId: id,
        previous: shapeGoal(existing[0]), next: goal,
      });
      res.json(goal);
    } catch (err) { next(err); }
  });


  /* ── Image (#1623, #1722 — a System goal's artwork, WebP master + thumbnail) ── */
  //
  // The gym route's mirror image, one root over: `cordel/nutrition_goals/`. There
  // is no per-gym bucket to initialize, so no 409; the folder markers are written
  // on demand. This router answers for System rows only (404 for a gym's goal).
  if (hasWebpImage) {
    async function loadSystemGoalForImage(req: any, res: any) {
      const { rows } = await db.query<{ id: number; name: string; status: string; image_url: string | null; image_thumbnail_url: string | null }>(
        `SELECT id, name, status, image_url, image_thumbnail_url FROM ${table} WHERE id = ? AND gym_id IS NULL`,
        [req.params.id],
      );
      const row = rows[0];
      if (!row) { res.status(404).json({ error: 'Goal not found' }); return null; }
      if (row.status === 'deleted') { res.status(409).json({ error: 'Goal is deleted' }); return null; }
      return { id: row.id, name: row.name, image_url: row.image_url, image_thumbnail_url: row.image_thumbnail_url };
    }

    router.post('/:id/image', requireSuperadmin, memberImageUploadRateLimit, memberImageBodyParser, async (req, res, next) => {
      try {
        const parsed = await parseMemberImageRequest(req);
        if (isMemberImageRefusal(parsed)) return res.status(parsed.status).json(parsed.body);
        const goal = await loadSystemGoalForImage(req, res);
        if (!goal) return;
        const stored = await storeNutritionGoalImage({
          scope: { gymId: null, prefix: PLATFORM_STORAGE_ROOT, kind },
          goal, images: parsed, modifiedBy: platformActor(req),
        });
        if (isMemberImageRefusal(stored)) return res.status(stored.status).json(stored.body);
        recordAudit(req, {
          action: 'update', entityType, entityId: goal.id,
          previous: { image_url: goal.image_url }, next: { image_url: stored.image_url },
        });
        res.json(await loadGoal(goal.id, getRequestLocale(req)));
      } catch (err) { next(err); }
    });

    router.delete('/:id/image', requireSuperadmin, async (req, res, next) => {
      try {
        const goal = await loadSystemGoalForImage(req, res);
        if (!goal) return;
        await clearNutritionGoalImage({
          scope: { gymId: null, prefix: PLATFORM_STORAGE_ROOT, kind },
          goal, modifiedBy: platformActor(req),
        });
        recordAudit(req, {
          action: 'update', entityType, entityId: goal.id,
          previous: { image_url: goal.image_url }, next: { image_url: null },
        });
        res.json(await loadGoal(goal.id, getRequestLocale(req)));
      } catch (err) { next(err); }
    });
  }

  /* ── Soft delete ────────────────────────────────────────────────────────── */

  router.delete('/:id', requireSuperadmin, async (req, res, next) => {
    const { id } = req.params;
    try {
      const { rows: existing } = await db.query(
        `SELECT id, status FROM ${table} WHERE id = ? AND gym_id IS NULL`,
        [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Goal is already deleted' });

      const actor = platformActor(req);
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

/** A DECIMAL the driver handed back as a string, as the number it is. */
function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export const platformPersonalGoalsRouter = createPlatformGoalLibraryRouter('personal');
export const platformNutritionGoalsRouter = createPlatformGoalLibraryRouter('nutrition');
