import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

/** Mounted at /staff/:staffId/centers (mergeParams: true), like member-centers.ts. */
export const staffCentersRouter = Router({ mergeParams: true });

staffCentersRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { staffId } = req.params as { staffId: string };
  const { rows } = await db.query(
    `SELECT c.id AS center_id, c.name, c.status, sc.is_default, sc.assigned_at
     FROM staff_centers sc
     JOIN centers c ON c.id = sc.center_id
     WHERE sc.staff_id = ? AND sc.gym_id = ? AND sc.deleted_at IS NULL
     ORDER BY sc.is_default DESC, c.name ASC`,
    [staffId, gymId],
  );
  res.json(rows);
});

staffCentersRouter.put('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { staffId } = req.params as { staffId: string };
  const { center_ids, default_center_id } = req.body as { center_ids: unknown; default_center_id: unknown };

  const ids = Array.isArray(center_ids) ? center_ids.map((id) => Number(id)) : [];
  if (ids.length > 0) {
    const defaultId = ids.length === 1 ? ids[0] : Number(default_center_id);
    if (!defaultId || !ids.includes(defaultId)) {
      return res.status(400).json({ error: 'default_center_id must be one of center_ids' });
    }
  }

  const { rows: staffRows } = await db.query(
    'SELECT id FROM staff WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [staffId, gymId],
  );
  if (staffRows.length === 0) return res.status(404).json({ error: 'Staff member not found' });

  if (ids.length > 0) {
    const { rows: validCenters } = await db.query(
      `SELECT id FROM centers WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
      [gymId, ...ids],
    );
    if (validCenters.length !== new Set(ids).size) {
      return res.status(400).json({ error: 'One or more center_ids are invalid for this gym' });
    }
  }
  const defaultId = ids.length === 1 ? ids[0] : Number(default_center_id);

  try {
    await db.transaction(async (tx) => {
      const { rows: current } = await tx.query<{ center_id: number }>(
        'SELECT center_id FROM staff_centers WHERE staff_id = ? AND gym_id = ? AND deleted_at IS NULL',
        [staffId, gymId],
      );
      const currentIds = current.map((r) => r.center_id);
      const toRemove = currentIds.filter((id) => !ids.includes(id));

      for (const centerId of toRemove) {
        await tx.query(
          `UPDATE staff_centers SET deleted_at = UTC_TIMESTAMP(), modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
           WHERE staff_id = ? AND center_id = ? AND gym_id = ?`,
          [gymMembershipId, staffId, centerId, gymId],
        );
      }
      for (const centerId of ids) {
        const isDefault = centerId === defaultId;
        await tx.query(
          `INSERT INTO staff_centers (gym_id, staff_id, center_id, is_default, assigned_at, assigned_by_membership_id, modified_at, modified_by_membership_id)
           VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), ?)
           ON DUPLICATE KEY UPDATE is_default = VALUES(is_default), deleted_at = NULL,
             modified_at = UTC_TIMESTAMP(), modified_by_membership_id = VALUES(modified_by_membership_id)`,
          [gymId, staffId, centerId, isDefault, gymMembershipId, gymMembershipId],
        );
      }
    });
  } catch (err) { return next(err); }

  recordAudit(req, { action: 'update', entityType: 'staff_centers', entityId: staffId, next: { center_ids: ids, default_center_id: defaultId || null } });

  const { rows } = await db.query(
    `SELECT c.id AS center_id, c.name, c.status, sc.is_default, sc.assigned_at
     FROM staff_centers sc
     JOIN centers c ON c.id = sc.center_id
     WHERE sc.staff_id = ? AND sc.gym_id = ? AND sc.deleted_at IS NULL
     ORDER BY sc.is_default DESC, c.name ASC`,
    [staffId, gymId],
  );
  res.json(rows);
});
