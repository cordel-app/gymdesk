import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

/** Mounted at /members/:memberId/centers (mergeParams: true), like training-plans.ts. */
export const memberCentersRouter = Router({ mergeParams: true });

memberCentersRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { memberId } = req.params as { memberId: string };
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

memberCentersRouter.put('/', requireRole('admin', 'staff'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { memberId } = req.params as { memberId: string };
  const { center_ids, default_center_id } = req.body as { center_ids: unknown; default_center_id: unknown };

  if (!Array.isArray(center_ids) || center_ids.length === 0) {
    return res.status(400).json({ error: 'A member must belong to at least one center' });
  }
  const ids = center_ids.map((id) => Number(id));
  const defaultId = Number(default_center_id);
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

  try {
    await db.transaction(async (tx) => {
      const { rows: current } = await tx.query<{ center_id: number }>(
        'SELECT center_id FROM member_centers WHERE member_id = ? AND gym_id = ? AND deleted_at IS NULL',
        [memberId, gymId],
      );
      const currentIds = current.map((r) => r.center_id);
      const toRemove = currentIds.filter((id) => !ids.includes(id));

      for (const centerId of toRemove) {
        await tx.query(
          `UPDATE member_centers SET deleted_at = UTC_TIMESTAMP(), modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
           WHERE member_id = ? AND center_id = ? AND gym_id = ?`,
          [gymMembershipId, memberId, centerId, gymId],
        );
      }
      for (const centerId of ids) {
        const isDefault = centerId === defaultId;
        await tx.query(
          `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at, assigned_by_membership_id, modified_at, modified_by_membership_id)
           VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), ?)
           ON DUPLICATE KEY UPDATE is_default = VALUES(is_default), deleted_at = NULL,
             modified_at = UTC_TIMESTAMP(), modified_by_membership_id = VALUES(modified_by_membership_id)`,
          [gymId, memberId, centerId, isDefault, gymMembershipId, gymMembershipId],
        );
      }
    });
  } catch (err) { return next(err); }

  recordAudit(req, { action: 'update', entityType: 'member_centers', entityId: memberId, next: { center_ids: ids, default_center_id: defaultId } });

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
