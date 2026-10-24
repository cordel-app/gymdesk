import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { GOAL_LIBRARY_AUDIT_ENTITIES, normalizeGoalName } from '../domain/goalLibrary';
import { BASE_LOCALE, SUPPORTED_LOCALES, TRANSLATABLE_LOCALES, getRequestLocale, SupportedLocale } from '../infra/locale';
import { PLATFORM_STORAGE_ROOT } from '../infra/storage';
import {
  goalTranslatedSearchSql,
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
import { normalizeTargetType, normalizeTargetUnit, normalizeTargetValue, targetPairError } from '../domain/goalTarget';
import { clampLimit, clampOffset, normalizeDescription } from '../domain/nutritionLibrary';
import { resolvePlatformActor } from '../domain/auditActor';

/**
 * #1849 — Cordel's Base Personal Goals, on `base_personal_goals`.
 *
 * Stage 2b moved this router onto the Base table and mirrored every write onto
 * the legacy System row of the same id, because the gym side still read it. Since
 * 2c-2e nothing reads the legacy System rows and since 2f-1 nothing references
 * them, so the mirror is gone: this router writes the Base table (and its own
 * translations) alone.
 *
 * Ids of Base goals and of gym-owned goals (`personal_goals`) must stay disjoint,
 * because `personal_goal_catalogue` and the readers address a goal by its bare
 * id. `allocateGoalId()` therefore draws a new Base id from the `personal_goals`
 * sequence, the one the gym-owned goals use.
 *
 * Response shape is the one the Admin has always read (`gym_id` null,
 * `status` active|deleted).
 */
const entityType = GOAL_LIBRARY_AUDIT_ENTITIES.personal;
const TABLE = 'base_personal_goals';
const KIND = 'base_personal' as const;

const columnsFor = (locale: SupportedLocale) => `g.id, NULL AS gym_id, g.slug, g.name,
    IF(g.deleted_at IS NULL, 'active', 'deleted') AS status,
    g.target_value, g.target_unit, g.target_type, g.image_url, g.image_thumbnail_url,
    ${localizedGoalExprs('g', locale, KIND)}, ${goalTranslationsExpr('g', 'translations', KIND)},
    g.created_at, g.modified_at, g.description, g.created_by, g.modified_by, g.deleted_at, g.deleted_by`;

/** A DECIMAL comes back from mysql2 as a string; reported as the number it is. */
function shapeGoal<T extends Record<string, any>>(input: T) {
  const row = withGoalTranslations(input as any) as T;
  return {
    ...row,
    target_value: row.target_value === null || row.target_value === undefined ? null : Number(row.target_value),
  };
}

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function readTarget(body: any) {
  const value = normalizeTargetValue(body?.target_value, { allowNegative: true });
  if ('error' in value) return { error: value.error };
  const type = normalizeTargetType(body?.target_type);
  if ('error' in type) return { error: type.error };
  const unit = normalizeTargetUnit(body?.target_unit);
  if ('error' in unit) return { error: unit.error };
  return { value: { value: value.value, unit: unit.value, type: type.value } };
}

/**
 * A new Base id from the gym-owned goals' sequence: a throw-away row takes the
 * next AUTO_INCREMENT value and is deleted in the same transaction. InnoDB never
 * hands a consumed value out again, so no gym-owned goal can ever get this id.
 */
async function allocateGoalId(tx: Tx): Promise<number> {
  const { insertId } = await tx.query(
    "INSERT INTO personal_goals (gym_id, name, status, created_by) VALUES (NULL, CONCAT('__reserved_id_', UUID()), 'deleted', 'System')",
  );
  await tx.query('DELETE FROM personal_goals WHERE id = ?', [insertId]);
  return insertId as number;
}

export function createPlatformBasePersonalGoalsRouter(): Router {
  const router = Router();
  const platformActor = (req: { superadminName?: string | null }) => resolvePlatformActor(req.superadminName);

  async function loadGoal(id: unknown, locale: SupportedLocale = BASE_LOCALE) {
    const { rows } = await db.query(`SELECT ${columnsFor(locale)} FROM ${TABLE} g WHERE g.id = ?`, [id]);
    return rows[0] ? shapeGoal(rows[0]) : undefined;
  }

  router.get('/locales', requireSuperadmin, (_req, res) => {
    res.json({ locales: SUPPORTED_LOCALES, base_locale: BASE_LOCALE, translatable: TRANSLATABLE_LOCALES });
  });

  router.get('/', requireSuperadmin, async (req, res, next) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const where: string[] = [];
    const params: unknown[] = [];
    if (status === 'deleted') where.push('g.deleted_at IS NOT NULL');
    else if (status) { where.push('g.deleted_at IS NULL'); }
    else where.push('g.deleted_at IS NULL');
    const term = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (term) {
      where.push(goalTranslatedSearchSql('g', KIND));
      params.push(`%${term}%`, `%${term}%`, `%${term}%`);
    }
    const clause = where.join(' AND ');
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);
    try {
      const { rows: countRows } = await db.query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${TABLE} g WHERE ${clause}`, params,
      );
      // LIMIT/OFFSET are interpolated: MySQL refuses a bound LIMIT; both are validated integers.
      const { rows } = await db.query(
        `SELECT ${columnsFor(getRequestLocale(req))} FROM ${TABLE} g WHERE ${clause} ORDER BY g.name ASC LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      res.json({ items: rows.map(shapeGoal), total: countRows[0]?.total ?? 0, limit, offset });
    } catch (err) { next(err); }
  });

  router.post('/', requireSuperadmin, async (req, res, next) => {
    const name = normalizeGoalName(req.body?.name, { required: true });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const target = readTarget(req.body);
    if ('error' in target) return res.status(400).json({ error: target.error });
    const pairError = targetPairError({
      targetValue: target.value.value ?? null,
      targetUnit: target.value.unit ?? null,
      targetType: target.value.type ?? 'absolute',
    });
    if (pairError) return res.status(400).json({ error: pairError });
    const goalTranslations = parseGoalTranslations(req.body);
    if (goalTranslations.error) return res.status(400).json({ error: goalTranslations.error });

    try {
      const { rows: existing } = await db.query(
        `SELECT id FROM ${TABLE} WHERE name = ? AND deleted_at IS NULL`, [name.value],
      );
      if (existing.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });

      const actor = platformActor(req);
      const insertId = await db.transaction(async (tx) => {
        const values = [
          name.value, description.value ?? null,
          target.value.value ?? null, target.value.unit ?? null, target.value.type ?? 'absolute',
        ];
        const goalId = await allocateGoalId(tx);
        await tx.query(
          `INSERT INTO ${TABLE} (id, name, description, target_value, target_unit, target_type, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [goalId, ...values, actor],
        );
        if (goalTranslations.translations) {
          await replaceGoalTranslations(tx, goalId, goalTranslations.translations, KIND);
        }
        return goalId as number;
      });
      const goal = await loadGoal(insertId, getRequestLocale(req));
      recordAudit(req, { action: 'create', entityType, entityId: insertId, next: goal });
      res.status(201).json(goal);
    } catch (err) { next(err); }
  });

  router.put('/:id', requireSuperadmin, async (req, res, next) => {
    const id = String(req.params.id);
    const name = normalizeGoalName(req.body?.name, { required: false });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const target = readTarget(req.body);
    if ('error' in target) return res.status(400).json({ error: target.error });
    const goalTranslations = parseGoalTranslations(req.body);
    if (goalTranslations.error) return res.status(400).json({ error: goalTranslations.error });

    try {
      const { rows: existing } = await db.query(
        `SELECT id, name, description, slug, IF(deleted_at IS NULL, 'active', 'deleted') AS status,
                image_url, image_thumbnail_url, target_value, target_unit, target_type
           FROM ${TABLE} WHERE id = ?`, [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Goal is deleted' });

      if (name.value !== undefined) {
        const { rows: conflict } = await db.query(
          `SELECT id FROM ${TABLE} WHERE name = ? AND id != ? AND deleted_at IS NULL`, [name.value, id],
        );
        if (conflict.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });
      }

      const updates = ['modified_at = UTC_TIMESTAMP()', 'modified_by = ?'];
      const params: unknown[] = [platformActor(req)];
      if (name.value !== undefined) { updates.push('name = ?'); params.push(name.value); }
      if (description.value !== undefined) { updates.push('description = ?'); params.push(description.value); }
      const pairError = targetPairError({
        targetValue: target.value.value === undefined ? toNumberOrNull(existing[0].target_value) : target.value.value,
        targetUnit: target.value.unit === undefined ? (existing[0].target_unit ?? null) : target.value.unit,
        targetType: target.value.type ?? (existing[0].target_type === 'relative' ? 'relative' : 'absolute'),
      });
      if (pairError) return res.status(400).json({ error: pairError });
      if (target.value.value !== undefined) { updates.push('target_value = ?'); params.push(target.value.value); }
      if (target.value.unit !== undefined) { updates.push('target_unit = ?'); params.push(target.value.unit); }
      if (target.value.type !== undefined) { updates.push('target_type = ?'); params.push(target.value.type); }
      params.push(id);
      await db.transaction(async (tx) => {
        await tx.query(`UPDATE ${TABLE} SET ${updates.join(', ')} WHERE id = ?`, params);
        if (goalTranslations.translations) {
          await replaceGoalTranslations(tx, String(id), goalTranslations.translations, KIND);
        }
      });

      // The image key carries the goal's name, so a rename moves it.
      if (name.value !== undefined && name.value !== existing[0].name && existing[0].image_url) {
        await migrateNutritionGoalImageOnRename(
          { gymId: null, prefix: PLATFORM_STORAGE_ROOT, kind: 'personal', table: TABLE },
          { id: existing[0].id, name: name.value, image_url: existing[0].image_url, image_thumbnail_url: existing[0].image_thumbnail_url ?? null },
        );
      }

      const goal = await loadGoal(id, getRequestLocale(req));
      recordAudit(req, { action: 'update', entityType, entityId: id, previous: shapeGoal(existing[0]), next: goal });
      res.json(goal);
    } catch (err) { next(err); }
  });

  /* ── Image (#1722 — WebP master + thumbnail under `cordel/goals/`) ─────── */

  async function loadForImage(req: any, res: any) {
    const { rows } = await db.query<any>(
      `SELECT id, name, deleted_at, image_url, image_thumbnail_url FROM ${TABLE} WHERE id = ?`, [String(req.params.id)],
    );
    const row = rows[0];
    if (!row) { res.status(404).json({ error: 'Goal not found' }); return null; }
    if (row.deleted_at) { res.status(409).json({ error: 'Goal is deleted' }); return null; }
    return { id: row.id, name: row.name, image_url: row.image_url, image_thumbnail_url: row.image_thumbnail_url };
  }

  const scope = { gymId: null, prefix: PLATFORM_STORAGE_ROOT, kind: 'personal' as const, table: TABLE };

  router.post('/:id/image', requireSuperadmin, memberImageUploadRateLimit, memberImageBodyParser, async (req, res, next) => {
    try {
      const parsed = await parseMemberImageRequest(req);
      if (isMemberImageRefusal(parsed)) return res.status(parsed.status).json(parsed.body);
      const goal = await loadForImage(req, res);
      if (!goal) return;
      const stored = await storeNutritionGoalImage({
        scope: scope as typeof scope & { prefix: string }, goal, images: parsed, modifiedBy: platformActor(req),
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
      const goal = await loadForImage(req, res);
      if (!goal) return;
      await clearNutritionGoalImage({ scope, goal, modifiedBy: platformActor(req) });
      recordAudit(req, {
        action: 'update', entityType, entityId: goal.id,
        previous: { image_url: goal.image_url }, next: { image_url: null },
      });
      res.json(await loadGoal(goal.id, getRequestLocale(req)));
    } catch (err) { next(err); }
  });

  router.delete('/:id', requireSuperadmin, async (req, res, next) => {
    const id = String(req.params.id);
    try {
      const { rows: existing } = await db.query(
        `SELECT id, IF(deleted_at IS NULL, 'active', 'deleted') AS status FROM ${TABLE} WHERE id = ?`, [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Goal is already deleted' });
      const actor = platformActor(req);
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE ${TABLE} SET deleted_at = UTC_TIMESTAMP(), deleted_by = ?, modified_at = UTC_TIMESTAMP() WHERE id = ?`,
          [actor, id],
        );
      });
      recordAudit(req, { action: 'delete', entityType, entityId: id, previous: existing[0] });
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}

export const platformPersonalGoalsRouter = createPlatformBasePersonalGoalsRouter();
