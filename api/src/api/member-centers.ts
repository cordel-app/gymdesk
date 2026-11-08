import { Router } from 'express';
import { db } from '../infra/db';
import { soleActiveCenterId } from '../infra/centerContext';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { resolveRequestActor } from '../domain/auditActor';
import { centersAvailableToMember, memberEffectiveCenterAccess } from './plan-center-access';

/** Mounted at /members/:memberId/centers (mergeParams: true), like training-plans.ts. */
export const memberCentersRouter = Router({ mergeParams: true });

/**
 * #797: this route is the one place a Member's centers are resolved for reading
 * — both the Edit form and the read-only PROFILE section of the expanded Member
 * row read it — so the sole-active-center fallback lives here rather than in
 * either caller. An empty `member_centers` list does not mean "no center": when
 * the gym has exactly one active center, that center is the Member's, which is
 * the same rule `resolveMemberCenters()` applies on creation (members.ts) and
 * `centerContext` applies to a member's own visibility. A gym with several
 * active centers has no fallback — there the assignment is explicit, and an
 * empty list really is empty.
 */
/**
 * #2381: the centers the Member may pick as Default Center, from their Membership
 * Plans (the booking hook's own coverage rule). Registered before nothing else
 * on '/', so the path cannot be read as an id.
 */
memberCentersRouter.get('/options', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { memberId } = req.params as { memberId: string };
  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });
  res.json(await centersAvailableToMember(gymId, memberId));
});

/** #2422: read-only effective center access, resolved from the Member's live plans. */
memberCentersRouter.get('/effective-access', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { memberId } = req.params as { memberId: string };
  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });
  res.json(await memberEffectiveCenterAccess(gymId, memberId));
});

memberCentersRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { memberId } = req.params as { memberId: string };

  // Checked before the fallback: without it an id from another gym (or none at
  // all) would read back the sole center of a single-center gym.
  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const { rows } = await db.query(
    `SELECT c.id AS center_id, c.name, c.status, mc.is_default, mc.assigned_at
     FROM member_centers mc
     JOIN centers c ON c.id = mc.center_id
     WHERE mc.member_id = ? AND mc.gym_id = ? AND mc.deleted_at IS NULL
     ORDER BY mc.is_default DESC, c.name ASC`,
    [memberId, gymId],
  );
  if (rows.length > 0) return res.json(rows);

  const soleId = await soleActiveCenterId(gymId);
  if (soleId == null) return res.json([]);
  const { rows: implied } = await db.query(
    `SELECT c.id AS center_id, c.name, c.status, 1 AS is_default, NULL AS assigned_at
     FROM centers c
     WHERE c.id = ? AND c.gym_id = ? AND c.deleted_at IS NULL`,
    [soleId, gymId],
  );
  res.json(implied);
});

memberCentersRouter.put('/', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const actor = resolveRequestActor(ctx);
  const { memberId } = req.params as { memberId: string };
  const { center_ids, default_center_id } = req.body as { center_ids: unknown; default_center_id: unknown };

  // #2381: the form no longer assigns centers. A body with only
  // default_center_id keeps every existing assignment and moves the default.
  const defaultOnly = center_ids === undefined;
  if (!defaultOnly && (!Array.isArray(center_ids) || center_ids.length === 0)) {
    return res.status(400).json({ error: 'A member must belong to at least one center' });
  }
  const defaultId = Number(default_center_id);
  const ids = defaultOnly ? [defaultId] : (center_ids as unknown[]).map((id) => Number(id));
  if (!defaultId || !ids.includes(defaultId)) {
    return res.status(400).json({ error: 'default_center_id must be one of center_ids' });
  }

  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  const { rows: validCenters } = await db.query(
    `SELECT id FROM centers WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    [gymId, ...ids],
  );
  if (validCenters.length !== new Set(ids).size) {
    return res.status(400).json({ error: 'One or more center_ids are invalid for this gym' });
  }

  if (defaultOnly) {
    const allowed = await centersAvailableToMember(gymId, memberId);
    if (!allowed.some((c) => c.id === defaultId)) {
      return res.status(400).json({ error: 'default_center_id is not covered by the member\'s membership plan' });
    }
  }

  try {
    await db.transaction(async (tx) => {
      if (defaultOnly) {
        await tx.query(
          `UPDATE member_centers SET is_default = 0, modified_at = UTC_TIMESTAMP(), modified_by = ?
           WHERE member_id = ? AND gym_id = ? AND center_id <> ? AND deleted_at IS NULL`,
          [actor, memberId, gymId, defaultId],
        );
        await tx.query(
          `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at, created_by, modified_at, modified_by)
           VALUES (?, ?, ?, 1, UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), ?)
           ON DUPLICATE KEY UPDATE is_default = 1, deleted_at = NULL, deleted_by = NULL,
             modified_at = UTC_TIMESTAMP(), modified_by = VALUES(modified_by)`,
          [gymId, memberId, defaultId, actor, actor],
        );
        return;
      }
      const { rows: current } = await tx.query<{ center_id: number }>(
        'SELECT center_id FROM member_centers WHERE member_id = ? AND gym_id = ? AND deleted_at IS NULL',
        [memberId, gymId],
      );
      const currentIds = current.map((r) => r.center_id);
      const toRemove = currentIds.filter((id) => !ids.includes(id));

      for (const centerId of toRemove) {
        await tx.query(
          `UPDATE member_centers SET deleted_at = UTC_TIMESTAMP(), deleted_by = ?
           WHERE member_id = ? AND center_id = ? AND gym_id = ?`,
          [actor, memberId, centerId, gymId],
        );
      }
      for (const centerId of ids) {
        const isDefault = centerId === defaultId;
        await tx.query(
          `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at, created_by, modified_at, modified_by)
           VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), ?)
           ON DUPLICATE KEY UPDATE is_default = VALUES(is_default), deleted_at = NULL, deleted_by = NULL,
             modified_at = UTC_TIMESTAMP(), modified_by = VALUES(modified_by)`,
          [gymId, memberId, centerId, isDefault, actor, actor],
        );
      }
    });
  } catch (err) { return next(err); }

  recordAudit(req, { action: 'update', entityType: 'member_centers', entityId: memberId, next: defaultOnly ? { default_center_id: defaultId } : { center_ids: ids, default_center_id: defaultId } });

  const { rows } = await db.query(
    `SELECT c.id AS center_id, c.name, c.status, mc.is_default, mc.assigned_at
     FROM member_centers mc
     JOIN centers c ON c.id = mc.center_id
     WHERE mc.member_id = ? AND mc.gym_id = ? AND mc.deleted_at IS NULL
     ORDER BY mc.is_default DESC, c.name ASC`,
    [memberId, gymId],
  );
  res.json(rows);
});
