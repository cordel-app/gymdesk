import { Router } from 'express';
import express from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireFeatureWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import {
  GOAL_LIBRARY_AUDIT_ENTITIES,
  GOAL_LIBRARY_FEATURE_KEYS,
  GOAL_LIBRARY_TABLES,
  GoalLibraryKind,
  buildGoalListWhere,
  goalKindHasImage,
  isMeasurableGoalKind,
  normalizeGoalName,
} from '../domain/goalLibrary';
// Where a Personal Goal's image goes and what counts as a valid one is decided
// in one place, shared with the platform router (#1035 stage 2).
import {
  PERSONAL_GOAL_IMAGE_MAX_BYTES,
  PERSONAL_GOAL_IMAGE_MIME,
  PERSONAL_GOAL_IMAGE_REJECTION_MESSAGES,
  buildGymPersonalGoalImageKey,
  gymPersonalGoalImageFolderKeys,
  isGymOwnedPersonalGoalImageUrl,
  validatePersonalGoalImage,
} from '../domain/personalGoalImages';
import {
  buildStorageObjectUrl,
  deleteStorageObject,
  describeStorageError,
  ensureStorageFolders,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  isStorageConfigured,
  StorageOperationError,
  storageKeyFromObjectUrl,
  uploadStorageObject,
} from '../infra/storage';
import { logger } from '../lib/logger';
// What a goal **target** is lives in one module, shared with the assignment side
// (#1034 §1 — "do not introduce a second, incompatible unit system").
import { normalizeTargetUnit, normalizeTargetValue, targetPairError } from '../domain/goalTarget';
// The description rules and the actor snapshot are the Foods library's, reused
// rather than restated: a goal row carries the same `description` + three actor
// pairs migration 196 put on `nutrition_library_items`, for the same #799 reasons,
// and `itemDetailColumnsSql` only ever names the alias it is given.
import {
  actorSnapshot, clampLimit, clampOffset, itemDetailColumnsSql, normalizeDescription,
} from '../domain/nutritionLibrary';

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
  const entityType = GOAL_LIBRARY_AUDIT_ENTITIES[kind];
  // #1034 §1: only a measurable kind has the pair, and `nutrition_goals` has no
  // such columns — projecting them there would answer ER_BAD_FIELD_ERROR, which
  // the global handler turns into a bare 500 (#966). `isMeasurableGoalKind()` is
  // the one place that decides it, asked here rather than branched on per route.
  const measurable = isMeasurableGoalKind(kind);
  // #1035 stage 2: the same declaration-rather-than-branch rule for `image_url`.
  // It also decides whether the two image routes are registered at all, so a
  // Nutrition Goal's `/:id/image` is a 404 rather than a write to a column that
  // does not exist.
  const hasImage = goalKindHasImage(kind);
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
  const COLUMNS = `g.id, g.gym_id, g.slug, g.name, g.status,${measurable ? ' g.target_value, g.target_unit,' : ''}${hasImage ? ' g.image_url,' : ''}
    g.created_at, g.modified_at,
    ${itemDetailColumnsSql('g', { maskPlatformActors: true })}`;

  /**
   * `target_value` is a DECIMAL, which mysql2 hands back as a string. Every
   * other number this API reports is a number (CLAUDE.md's rule for
   * `shapeProductBenefitRow()`), so the conversion happens once, here, rather
   * than in whichever page renders it. A non-measurable kind has no such key and
   * the row passes through untouched.
   */
  function shapeGoal<T extends Record<string, unknown>>(row: T) {
    if (!row || !measurable) return row;
    return {
      ...row,
      target_value: row.target_value === null || row.target_value === undefined
        ? null
        : Number(row.target_value),
    };
  }

  async function loadGoal(id: unknown) {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${table} g WHERE g.id = ?`, [id]);
    return rows[0] ? shapeGoal(rows[0]) : undefined;
  }

  /**
   * The submitted target pair, or the 400 that describes it. Answered for a
   * measurable kind only: a request that names a target on a Nutrition Goal is
   * ignored rather than refused, exactly as a submitted `slug` is — there is no
   * column for it, and the field is not part of that kind's contract.
   */
  function readTarget(body: any): { value: { value: number | null | undefined; unit: string | null | undefined } } | { error: string } {
    if (!measurable) return { value: { value: undefined, unit: undefined } };
    const value = normalizeTargetValue(body?.target_value);
    if ('error' in value) return { error: value.error };
    const unit = normalizeTargetUnit(body?.target_unit);
    if ('error' in unit) return { error: unit.error };
    return { value: { value: value.value, unit: unit.value } };
  }

  /* ── List ───────────────────────────────────────────────────────────────── */

  router.get('/', async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const { where, params } = buildGoalListWhere(
      req.query.search,
      ['(g.gym_id IS NULL OR g.gym_id = ?)', "g.status != 'deleted'"],
      [gymId],
    );
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);

    try {
      const { rows: countRows } = await db.query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${table} g WHERE ${where}`,
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
        `SELECT ${COLUMNS} FROM ${table} g WHERE ${where} ORDER BY g.name ASC LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      res.json({ items: rows.map(shapeGoal), total: countRows[0]?.total ?? 0, limit, offset });
    } catch (err) { next(err); }
  });

  /* ── Create (gym-owned goals only) ──────────────────────────────────────── */

  router.post('/', requireWrite, async (req, res, next) => {
    const { gymId, actorName, isSuperadmin } = getTenantContext(req);
    const name = normalizeGoalName(req.body?.name, { required: true });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const target = readTarget(req.body);
    if ('error' in target) return res.status(400).json({ error: target.error });
    // On a create an unmentioned field is simply empty, so the cross-field rule
    // is applied to exactly what will be stored.
    const pairError = targetPairError({
      targetValue: target.value.value ?? null,
      targetUnit: target.value.unit ?? null,
    });
    if (pairError) return res.status(400).json({ error: pairError });
    const actor = actorSnapshot({ name: actorName, isSuperadmin });

    try {
      // Scoped to this gym's own rows: a System goal called "Water" must not stop
      // a gym from naming one of its own the same way, which is also what the
      // (gym, name) shape of `<prefix>_live_name_key` allows.
      const { rows: existing } = await db.query(
        `SELECT id FROM ${table} WHERE gym_id = ? AND name = ? AND status != 'deleted'`,
        [gymId, name.value],
      );
      if (existing.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });

      // `slug` is deliberately not written: it is a System row's label handle and
      // `chk_<prefix>_slug_system_only` refuses one on a gym row.
      const { insertId } = await db.query(
        `INSERT INTO ${table} (gym_id, name, description,${measurable ? ' target_value, target_unit,' : ''}
           status, created_by_name, created_by_type)
         VALUES (?, ?, ?,${measurable ? ' ?, ?,' : ''} 'active', ?, ?)`,
        [
          gymId, name.value, description.value ?? null,
          ...(measurable ? [target.value.value ?? null, target.value.unit ?? null] : []),
          actor.name, actor.type,
        ],
      );
      const goal = await loadGoal(insertId);
      recordAudit(req, { action: 'create', entityType, entityId: insertId, next: goal });
      res.status(201).json(goal);
    } catch (err) { next(err); }
  });

  /* ── Update (gym-owned goals only — System goals are read-only here) ────── */

  router.put('/:id', requireWrite, async (req, res, next) => {
    const { gymId, actorName, isSuperadmin } = getTenantContext(req);
    const { id } = req.params;
    const name = normalizeGoalName(req.body?.name, { required: false });
    if ('error' in name) return res.status(400).json({ error: name.error });
    const description = normalizeDescription(req.body?.description);
    if ('error' in description) return res.status(400).json({ error: description.error });
    const target = readTarget(req.body);
    if ('error' in target) return res.status(400).json({ error: target.error });
    const actor = actorSnapshot({ name: actorName, isSuperadmin });

    try {
      const { rows: existing } = await db.query(
        `SELECT id, gym_id, name, description, status${measurable ? ', target_value, target_unit' : ''}
         FROM ${table} WHERE id = ?`,
        [id],
      );
      if (existing.length === 0) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].gym_id === null) return res.status(403).json({ error: 'System goals are read-only' });
      if (existing[0].gym_id !== gymId) return res.status(404).json({ error: 'Goal not found' });
      if (existing[0].status === 'deleted') return res.status(409).json({ error: 'Goal is deleted' });

      if (name.value !== undefined) {
        const { rows: conflict } = await db.query(
          `SELECT id FROM ${table} WHERE gym_id = ? AND name = ? AND id != ? AND status != 'deleted'`,
          [gymId, name.value, id],
        );
        if (conflict.length > 0) return res.status(409).json({ error: 'A goal with this name already exists' });
      }

      // The actor pair moves with every edit, so `modified_by_name` always names
      // whoever `modified_at` refers to (#799 §13).
      const updates = ['modified_at = UTC_TIMESTAMP()', 'modified_by_name = ?', 'modified_by_type = ?'];
      const params: unknown[] = [actor.name, actor.type];
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
        });
        if (pairError) return res.status(400).json({ error: pairError });
        if (target.value.value !== undefined) { updates.push('target_value = ?'); params.push(target.value.value); }
        if (target.value.unit !== undefined) { updates.push('target_unit = ?'); params.push(target.value.unit); }
      }
      params.push(id);
      await db.query(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = ?`, params);

      const goal = await loadGoal(id);
      recordAudit(req, {
        action: 'update', entityType, entityId: id,
        previous: shapeGoal(existing[0]), next: goal,
      });
      res.json(goal);
    } catch (err) { next(err); }
  });


  /* ── Image (#1035 stage 2 — a Personal Goal's own artwork) ──────────────── */
  //
  // Registered only for a kind that has the column, so there is no route here
  // for a Nutrition Goal rather than one that writes nowhere (#974's rule, in
  // the router instead of the form).
  //
  // The route takes neither the folder nor the key from the request: the prefix
  // is the gym's own `storage_folder_prefix` column, the goal is looked up
  // inside the tenant, and the key is built from the row's id and name. Nothing
  // a client sends can reach another gym's folder or the platform's (#719 §18).
  //
  // Validation is the file's, not the request's: the `Content-Type` header and
  // the file name are both the client's word. Nothing is uploaded and nothing is
  // written until the bytes pass, which is how "an invalid upload does not
  // replace or delete the existing image" holds.
  if (hasImage) {
    /**
     * The gym's own R2 folder prefix, or null for a gym whose bucket was never
     * initialized. An upload needs somewhere to put the object, so that case is
     * a 409; removing an image needs no folder at all — the reference is the
     * gym's to clear either way, and an object that cannot be identified as the
     * gym's is not deleted anyway (`loadExerciseForMedia()`'s rule, #719).
     */
    async function gymStorageFolderPrefix(gymId: string): Promise<string | null> {
      const { rows } = await db.query<{ storage_folder_prefix: string | null }>(
        'SELECT storage_folder_prefix FROM gyms WHERE id = ? AND deleted_at IS NULL',
        [gymId],
      );
      return rows[0]?.storage_folder_prefix ?? null;
    }

    /**
     * The gym-owned, editable goal this request is about, or the response that
     * says why there isn't one.
     *
     * A **System** row (`gym_id IS NULL`) answers 403 exactly as `PUT /:id`
     * does: it is administered from Cordel, and `/platform/personal-goals` is
     * where its image is uploaded. Another gym's row is a 404, whatever the
     * payload says.
     */
    async function loadGoalForImage(
      req: any,
      res: any,
      options: { requireStoragePrefix: boolean },
    ): Promise<{ gymId: string; folderPrefix: string | null; goal: { id: number; name: string; image_url: string | null } } | null> {
      const { gymId } = getTenantContext(req);
      const { rows } = await db.query<{ id: number; gym_id: string | null; name: string; status: string; image_url: string | null }>(
        `SELECT id, gym_id, name, status, image_url FROM ${table} WHERE id = ?`,
        [req.params.id],
      );
      const row = rows[0];
      if (row && row.gym_id === null) {
        res.status(403).json({ error: 'System goals are read-only' });
        return null;
      }
      if (!row || row.gym_id !== gymId) {
        res.status(404).json({ error: 'Goal not found' });
        return null;
      }
      if (row.status === 'deleted') {
        res.status(409).json({ error: 'Goal is deleted' });
        return null;
      }
      const folderPrefix = await gymStorageFolderPrefix(gymId);
      if (!folderPrefix && options.requireStoragePrefix) {
        res.status(409).json({
          error: 'Cloudflare storage has not been initialized for this gym, therefore images cannot be uploaded.',
        });
        return null;
      }
      return { gymId, folderPrefix, goal: { id: row.id, name: row.name, image_url: row.image_url } };
    }

    /**
     * Best-effort removal of the object a goal has stopped pointing at, always
     * *after* the row has moved: a failure here leaves an orphan to sweep rather
     * than a goal pointing at nothing.
     *
     * `isGymOwnedPersonalGoalImageUrl()` is what keeps a System object
     * (`cordel/goals/…`), another gym's object and an external URL out of this —
     * a gym operation never deletes media it does not own (#719 §19).
     *
     * There is no "is anything else still pointing at this?" check because
     * nothing copies a goal's image *reference*: the catalogue has no duplicate,
     * clone or import path (unlike exercises, #719), and the key carries the
     * row's own id, so two goals cannot share an object by construction.
     */
    async function sweepReplacedImage(
      folderPrefix: string | null,
      goalId: number,
      staleUrl: string | null,
      keepUrl: string | null,
    ): Promise<void> {
      if (!staleUrl || staleUrl === keepUrl) return;
      if (!isGymOwnedPersonalGoalImageUrl(staleUrl, folderPrefix)) return;
      const staleKey = storageKeyFromObjectUrl(staleUrl);
      if (!staleKey) return;
      const keepKey = keepUrl ? storageKeyFromObjectUrl(keepUrl) : null;
      if (keepKey && staleKey === keepKey) return;
      try {
        await deleteStorageObject(staleKey);
      } catch (err: any) {
        const details = err instanceof StorageOperationError
          ? err.details
          : describeStorageError(err, { operation: 'deleteStorageObject', key: staleKey });
        logger.warn({ err, details, goalId }, 'Replaced personal goal image left an orphaned object in Cloudflare R2');
      }
    }

    router.post(
      '/:id/image',
      requireWrite,
      // Raw bytes rather than JSON-with-base64: one file, so there is no pair to
      // keep atomic (which is why an exercise image is JSON, #719 Q2), and this
      // is the shape `POST /platform/nutrition-library/:id/image` already takes.
      // `express.json()` only parses `application/json`, so no app-level parser
      // has to move for this.
      express.raw({
        type: (req: any) => (req.headers['content-type'] ?? '').startsWith('image/'),
        limit: PERSONAL_GOAL_IMAGE_MAX_BYTES + 64 * 1024,
      }),
      async (req, res, next) => {
        try {
          const mime = req.headers['content-type']?.split(';')[0]?.trim();
          if (mime !== PERSONAL_GOAL_IMAGE_MIME) {
            return res.status(415).json({ error: `Unsupported image type. Allowed: ${PERSONAL_GOAL_IMAGE_MIME}` });
          }
          // `req.body` is whatever a parser left there, and a request can make
          // that a string or an array — both carry a `length` and numeric
          // indices, so they would flow into the size and signature checks as if
          // they were bytes (CodeQL `js/type-confusion-through-parameter-tampering`).
          const raw: unknown = req.body;
          if (typeof raw === 'string' || Array.isArray(raw) || !Buffer.isBuffer(raw)) {
            return res.status(400).json({ error: 'Request body must be raw image bytes' });
          }
          const body: Buffer = raw;
          if (body.length === 0) return res.status(400).json({ error: 'Request body is empty' });
          if (body.length > PERSONAL_GOAL_IMAGE_MAX_BYTES) {
            return res.status(413).json({ error: `Image exceeds ${PERSONAL_GOAL_IMAGE_MAX_BYTES / (1024 * 1024)} MB limit` });
          }
          const rejection = validatePersonalGoalImage(body);
          if (rejection) {
            return res.status(400).json({ error: PERSONAL_GOAL_IMAGE_REJECTION_MESSAGES[rejection], reason: rejection });
          }

          if (!isStorageConfigured()) {
            const missingConfig = getMissingStorageConfigKeys();
            return res.status(503).json({
              error: `Cloudflare storage has not been configured for this deployment (missing: ${missingConfig.join(', ')})`,
              missingConfig,
            });
          }

          const context = await loadGoalForImage(req, res, { requireStoragePrefix: true });
          if (!context) return;
          const { gymId, goal } = context;
          const folderPrefix = context.folderPrefix as string;

          const key = buildGymPersonalGoalImageKey(folderPrefix, goal.id, goal.name);
          const url = buildStorageObjectUrl(key);

          try {
            await ensureStorageFolders(gymPersonalGoalImageFolderKeys(folderPrefix));
            await uploadStorageObject(key, PERSONAL_GOAL_IMAGE_MIME, body);
          } catch (err: any) {
            const details = err instanceof StorageOperationError
              ? err.details
              : describeStorageError(err, { operation: 'uploadStorageObject', key });
            logger.error(
              { err, details, diagnostics: getStorageDiagnostics(), gymId, goalId: goal.id },
              'Cloudflare R2 personal goal image upload failed',
            );
            // The row still points at whatever it pointed at before, so the
            // previous image stays visible — nothing was written.
            return res.status(502).json({ error: `Failed to upload image: ${details.message}`, details });
          }

          const { actorName, isSuperadmin } = getTenantContext(req);
          const imageActor = actorSnapshot({ name: actorName, isSuperadmin });
          await db.query(
            `UPDATE ${table}
             SET image_url = ?, modified_at = UTC_TIMESTAMP(), modified_by_name = ?, modified_by_type = ?
             WHERE id = ? AND gym_id = ?`,
            [url, imageActor.name, imageActor.type, goal.id, gymId],
          );

          // The key is deterministic, so a replacement normally overwrites its
          // own object and there is nothing to sweep. What this catches is a key
          // that genuinely moved: the goal was renamed since its last upload, or
          // its image predates this shape.
          await sweepReplacedImage(folderPrefix, goal.id, goal.image_url, url);

          const updated = await loadGoal(goal.id);
          recordAudit(req, {
            action: 'update', entityType, entityId: goal.id,
            previous: { image_url: goal.image_url }, next: { image_url: url },
          });
          res.json(updated);
        } catch (err) { next(err); }
      },
    );

    /**
     * Clears a gym goal's image. The reference goes and the gym's own object is
     * deleted; a System object and an external URL are left alone. There is
     * deliberately **no fallback** to the System goal's image afterwards — the
     * goal simply has none (#719 §13's rule, which this feature inherits
     * wholesale).
     */
    router.delete('/:id/image', requireWrite, async (req, res, next) => {
      try {
        const context = await loadGoalForImage(req, res, { requireStoragePrefix: false });
        if (!context) return;
        const { gymId, folderPrefix, goal } = context;

        const { actorName, isSuperadmin } = getTenantContext(req);
        const imageActor = actorSnapshot({ name: actorName, isSuperadmin });
        await db.query(
          `UPDATE ${table}
           SET image_url = NULL, modified_at = UTC_TIMESTAMP(), modified_by_name = ?, modified_by_type = ?
           WHERE id = ? AND gym_id = ?`,
          [imageActor.name, imageActor.type, goal.id, gymId],
        );

        await sweepReplacedImage(folderPrefix, goal.id, goal.image_url, null);

        const updated = await loadGoal(goal.id);
        recordAudit(req, {
          action: 'update', entityType, entityId: goal.id,
          previous: { image_url: goal.image_url }, next: { image_url: null },
        });
        res.json(updated);
      } catch (err) { next(err); }
    });
  }

  /* ── Soft delete (gym-owned goals only) ─────────────────────────────────── */

  router.delete('/:id', requireWrite, async (req, res, next) => {
    const { gymId, actorName, isSuperadmin } = getTenantContext(req);
    const { id } = req.params;
    const actor = actorSnapshot({ name: actorName, isSuperadmin });

    try {
      const { rows: existing } = await db.query(
        `SELECT id, gym_id, status FROM ${table} WHERE id = ?`,
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
         SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), deleted_by_name = ?, deleted_by_type = ?,
             modified_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [actor.name, actor.type, id],
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
