import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite, requireRole } from '../infra/tenantContext';
import { resolveCenterId } from '../infra/centerContext';
import { recordAudit } from '../infra/audit';
import { insertAndFetch } from '../infra/db-helpers';
import { sendBulkNotification } from '../infra/notifications';

const STATUSES = ['scheduled', 'cancelled', 'completed'] as const;

/**
 * Effective capacity: COALESCE(cs.max_capacity_override, ct.max_capacity).
 * This is what booking (P2.5) will compare confirmed bookings against.
 *
 * #323+#324: sharing fields — is_shareable, allows_shared_booking, concurrent_groups_count,
 * effective_max_groups (min of trainer and space concurrent-group limits).
 */
const SELECT = `
  SELECT cs.*,
         at.name AS class_type_name,
         at.max_capacity AS class_type_capacity,
         at.duration_minutes AS class_type_duration,
         at.is_shareable,
         COALESCE(cs.max_capacity_override, at.max_capacity) AS effective_capacity,
         sp.name AS space_name,
         COALESCE(sp.max_concurrent_groups, 1) AS space_max_concurrent_groups,
         COALESCE(gm.max_concurrent_groups, 1) AS trainer_max_concurrent_groups,
         CASE
           WHEN cs.trainer_membership_id IS NOT NULL AND cs.space_id IS NOT NULL
           THEN LEAST(COALESCE(gm.max_concurrent_groups, 1), COALESCE(sp.max_concurrent_groups, 1))
           ELSE 1
         END AS effective_max_groups,
         CASE
           WHEN cs.trainer_membership_id IS NOT NULL AND cs.space_id IS NOT NULL
           THEN (
             SELECT COUNT(*) FROM class_sessions cs2
             WHERE cs2.gym_id = cs.gym_id
               AND cs2.trainer_membership_id = cs.trainer_membership_id
               AND cs2.space_id = cs.space_id
               AND cs2.starts_at = cs.starts_at
               AND cs2.ends_at = cs.ends_at
               AND cs2.status <> 'cancelled'
               AND cs2.deleted_at IS NULL
           )
           ELSE 1
         END AS concurrent_groups_count,
         etm.name AS effective_trainer_name,
         (SELECT COUNT(*) FROM bookings b WHERE b.class_session_id = cs.id AND b.status = 'booked') AS booked_count,
         (SELECT COUNT(*) FROM bookings b WHERE b.class_session_id = cs.id AND b.status = 'booked' AND b.attendance_status = 'present')  AS attendance_present,
         (SELECT COUNT(*) FROM bookings b WHERE b.class_session_id = cs.id AND b.status = 'booked' AND b.attendance_status = 'absent')   AS attendance_absent,
         (SELECT COUNT(*) FROM bookings b WHERE b.class_session_id = cs.id AND b.status = 'booked' AND b.attendance_status = 'pending')  AS attendance_pending
  FROM class_sessions cs
  JOIN activity_types at ON at.id = cs.activity_type_id
  LEFT JOIN spaces sp ON sp.id = cs.space_id
  LEFT JOIN gym_memberships gm  ON gm.id  = cs.trainer_membership_id
  LEFT JOIN gym_memberships etm ON etm.id = cs.effective_trainer_membership_id
`;

export const classSessionsRouter = Router();

classSessionsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { from, to, status, center_id, activity_type_id, space_id, trainer_membership_id } = req.query as Record<string, string | undefined>;
  const where: string[] = ['cs.gym_id = ?', 'cs.deleted_at IS NULL'];
  const params: any[] = [gymId];
  if (from) { where.push('cs.starts_at >= ?'); params.push(from); }
  if (to)   { where.push('cs.starts_at <= ?'); params.push(to); }
  if (status && STATUSES.includes(status as any)) { where.push('cs.status = ?'); params.push(status); }
  if (center_id)              { where.push('cs.center_id = ?');              params.push(center_id); }
  if (activity_type_id)       { where.push('cs.activity_type_id = ?');       params.push(activity_type_id); }
  if (space_id)               { where.push('cs.space_id = ?');               params.push(space_id); }
  if (trainer_membership_id)  { where.push('cs.trainer_membership_id = ?');  params.push(trainer_membership_id); }
  const { rows } = await db.query(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY cs.starts_at ASC`,
    params,
  );
  res.json(rows);
});

classSessionsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${SELECT} WHERE cs.id = ? AND cs.gym_id = ? AND cs.deleted_at IS NULL`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });
  res.json(rows[0]);
});

async function validateRefs(gymId: string, body: any, centerId: number) {
  if (body.activity_type_id) {
    const { rows } = await db.query(
      "SELECT id, status FROM activity_types WHERE id = ? AND gym_id = ?",
      [body.activity_type_id, gymId],
    );
    if (rows.length === 0) return 'Activity type not found';
    if (rows[0].status !== 'active') return 'Activity type is inactive';
  }
  if (body.trainer_membership_id) {
    const { rows } = await db.query(
      "SELECT id FROM gym_memberships WHERE id = ? AND gym_id = ? AND role IN ('trainer_performance','trainer_perf_nutrition')",
      [body.trainer_membership_id, gymId],
    );
    if (rows.length === 0) return 'Trainer not found';
  }
  if (body.space_id) {
    const { rows } = await db.query(
      "SELECT id, status, center_id FROM spaces WHERE id = ? AND gym_id = ? AND deleted_at IS NULL",
      [body.space_id, gymId],
    );
    if (rows.length === 0) return 'Space not found';
    if (rows[0].status !== 'active') return 'Space is inactive';
    if (rows[0].center_id !== centerId) return 'Space does not belong to this session\'s center';
  }
  return null;
}

classSessionsRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, userId, gymMembershipId } = getTenantContext(req);
  const { activity_type_id, trainer_membership_id, space_id, starts_at, ends_at, max_capacity_override, center_id } = req.body;
  if (!activity_type_id || !starts_at || !ends_at) {
    return res.status(400).json({ error: 'activity_type_id, starts_at and ends_at are required' });
  }
  if (new Date(starts_at) >= new Date(ends_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }

  const cap = max_capacity_override != null && max_capacity_override !== '' ? parseInt(max_capacity_override, 10) : null;
  if (cap !== null && (isNaN(cap) || cap <= 0)) {
    return res.status(400).json({ error: 'max_capacity_override must be a positive integer' });
  }

  try {
    const resolvedCenterId = await resolveCenterId(gymId, req, center_id);
    const err = await validateRefs(gymId, req.body, resolvedCenterId);
    if (err) return res.status(err.includes('inactive') || err.includes('center') ? 400 : 404).json({ error: err });

    const trainerId = trainer_membership_id ?? null;
    const spaceIdVal = space_id ?? null;
    const startsAtDate = new Date(starts_at);
    const endsAtDate = new Date(ends_at);

    // When both trainer and space are set, validate concurrent-group capacity atomically.
    if (trainerId && spaceIdVal) {
      const { rows: atRows } = await db.query(
        'SELECT is_shareable FROM activity_types WHERE id = ? AND gym_id = ?',
        [activity_type_id, gymId],
      );
      const newShareable = !!atRows[0]?.is_shareable;

      const row = await db.transaction(async (tx) => {
        const { rows: existing } = await tx.query(
          `SELECT cs.id, at.is_shareable AS act_shareable, cs.allows_shared_booking,
                  COALESCE(gm.max_concurrent_groups, 1) AS trainer_max,
                  COALESCE(sp.max_concurrent_groups, 1) AS space_max
           FROM class_sessions cs
           JOIN activity_types at ON at.id = cs.activity_type_id
           JOIN gym_memberships gm ON gm.id = cs.trainer_membership_id
           JOIN spaces sp ON sp.id = cs.space_id
           WHERE cs.gym_id = ? AND cs.trainer_membership_id = ? AND cs.space_id = ?
             AND cs.starts_at = ? AND cs.ends_at = ?
             AND cs.status <> 'cancelled' AND cs.deleted_at IS NULL
           FOR UPDATE`,
          [gymId, trainerId, spaceIdVal, startsAtDate, endsAtDate],
        );

        if (existing.length > 0) {
          const effectiveMax = Math.min(
            Number(existing[0].trainer_max),
            Number(existing[0].space_max),
          );
          if (existing.length >= effectiveMax) {
            throw Object.assign(new Error('Slot is fully occupied'), { status: 409, code: 'slot_fully_occupied' });
          }
          const nonShareable = existing.find((r: any) => !r.act_shareable);
          if (nonShareable) {
            throw Object.assign(new Error('An existing session at this slot is not eligible for shared training'), { status: 409, code: 'slot_not_shareable' });
          }
          if (!newShareable) {
            throw Object.assign(new Error('This activity is not eligible for shared training'), { status: 409, code: 'activity_not_shareable' });
          }
          const sharingAuthorized = existing.some((r: any) => r.allows_shared_booking);
          if (!sharingAuthorized) {
            throw Object.assign(new Error('Sharing is not authorized for this slot'), {
              status: 409, code: 'sharing_not_authorized', host_session_id: existing[0].id,
            });
          }
        }

        const { insertId } = await tx.query(
          `INSERT INTO class_sessions
           (gym_id, center_id, activity_type_id, trainer_membership_id, space_id, starts_at, ends_at, max_capacity_override, created_by, modified_by_membership_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gymId, resolvedCenterId, activity_type_id, trainerId, spaceIdVal,
           startsAtDate, endsAtDate, cap, userId, gymMembershipId],
        );
        const { rows } = await tx.query(`${SELECT} WHERE cs.id = ?`, [insertId]);
        return rows[0];
      });

      recordAudit(req, { action: 'create', entityType: 'class_session', entityId: row.id, next: row });
      return res.status(201).json(row);
    }

    // No concurrent-group check needed when trainer or space is absent.
    const row = await insertAndFetch(
      `INSERT INTO class_sessions
       (gym_id, center_id, activity_type_id, trainer_membership_id, space_id, starts_at, ends_at, max_capacity_override, created_by, modified_by_membership_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, resolvedCenterId, activity_type_id, trainerId, spaceIdVal,
       startsAtDate, endsAtDate, cap, userId, gymMembershipId],
      `${SELECT} WHERE cs.id = ?`,
      (id) => [id],
    );
    recordAudit(req, { action: 'create', entityType: 'class_session', entityId: row.id, next: row });
    res.status(201).json(row);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code, host_session_id: e.host_session_id });
    next(e);
  }
});

classSessionsRouter.put('/:id', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { trainer_membership_id, space_id, starts_at, ends_at, max_capacity_override, activity_type_id, allows_shared_booking } = req.body;
  if (starts_at && ends_at && new Date(starts_at) >= new Date(ends_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }

  try {
    const { rows: existingRows } = await db.query(
      `SELECT cs.center_id, cs.trainer_membership_id AS cur_trainer, cs.space_id AS cur_space,
              cs.starts_at AS cur_starts, cs.ends_at AS cur_ends, cs.activity_type_id AS cur_activity
       FROM class_sessions cs WHERE cs.id = ? AND cs.gym_id = ? AND cs.deleted_at IS NULL`,
      [req.params.id, gymId],
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Session not found' });
    const cur = existingRows[0];

    const err = await validateRefs(gymId, req.body, cur.center_id);
    if (err) return res.status(err.includes('inactive') || err.includes('center') ? 400 : 404).json({ error: err });

    // Resolve effective post-update slot values for sharing revalidation.
    const effTrainer = 'trainer_membership_id' in req.body ? (trainer_membership_id ?? null) : cur.cur_trainer;
    const effSpace   = 'space_id'               in req.body ? (space_id ?? null)               : cur.cur_space;
    const effStarts  = starts_at ? new Date(starts_at) : cur.cur_starts;
    const effEnds    = ends_at   ? new Date(ends_at)   : cur.cur_ends;
    const effActivity = 'activity_type_id' in req.body ? activity_type_id : cur.cur_activity;

    // When the effective slot (trainer + space + time) changes and both trainer+space are set,
    // revalidate concurrent-group capacity atomically.
    const slotChanged = effTrainer !== cur.cur_trainer || effSpace !== cur.cur_space ||
      String(effStarts) !== String(cur.cur_starts) || String(effEnds) !== String(cur.cur_ends) ||
      effActivity !== cur.cur_activity;

    if (slotChanged && effTrainer && effSpace) {
      const { rows: atRows } = await db.query(
        'SELECT is_shareable FROM activity_types WHERE id = ? AND gym_id = ?',
        [effActivity, gymId],
      );
      const newShareable = !!atRows[0]?.is_shareable;

      await db.transaction(async (tx) => {
        // Lock other sessions at the target slot (excluding this session).
        const { rows: existing } = await tx.query(
          `SELECT cs.id, at.is_shareable AS act_shareable, cs.allows_shared_booking,
                  COALESCE(gm.max_concurrent_groups, 1) AS trainer_max,
                  COALESCE(sp.max_concurrent_groups, 1) AS space_max
           FROM class_sessions cs
           JOIN activity_types at ON at.id = cs.activity_type_id
           JOIN gym_memberships gm ON gm.id = cs.trainer_membership_id
           JOIN spaces sp ON sp.id = cs.space_id
           WHERE cs.gym_id = ? AND cs.trainer_membership_id = ? AND cs.space_id = ?
             AND cs.starts_at = ? AND cs.ends_at = ?
             AND cs.status <> 'cancelled' AND cs.deleted_at IS NULL
             AND cs.id <> ?
           FOR UPDATE`,
          [gymId, effTrainer, effSpace, effStarts, effEnds, req.params.id],
        );

        if (existing.length > 0) {
          const effectiveMax = Math.min(Number(existing[0].trainer_max), Number(existing[0].space_max));
          if (existing.length >= effectiveMax) {
            throw Object.assign(new Error('Slot is fully occupied'), { status: 409, code: 'slot_fully_occupied' });
          }
          const nonShareable = existing.find((r: any) => !r.act_shareable);
          if (nonShareable) {
            throw Object.assign(new Error('An existing session at this slot is not eligible for shared training'), { status: 409, code: 'slot_not_shareable' });
          }
          if (!newShareable) {
            throw Object.assign(new Error('This activity is not eligible for shared training'), { status: 409, code: 'activity_not_shareable' });
          }
          const sharingAuthorized = existing.some((r: any) => r.allows_shared_booking);
          if (!sharingAuthorized) {
            throw Object.assign(new Error('Sharing is not authorized for this slot'), {
              status: 409, code: 'sharing_not_authorized', host_session_id: existing[0].id,
            });
          }
        }

        await tx.query(
          `UPDATE class_sessions SET
            activity_type_id      = COALESCE(?, activity_type_id),
            trainer_membership_id = IF(?, ?, trainer_membership_id),
            space_id              = IF(?, ?, space_id),
            starts_at             = COALESCE(?, starts_at),
            ends_at               = COALESCE(?, ends_at),
            max_capacity_override = IF(?, ?, max_capacity_override),
            modified_by_membership_id = ?
           WHERE id = ? AND gym_id = ?`,
          [
            activity_type_id ?? null,
            'trainer_membership_id' in req.body ? 1 : 0, trainer_membership_id ?? null,
            'space_id'              in req.body ? 1 : 0, space_id ?? null,
            starts_at ? new Date(starts_at) : null,
            ends_at   ? new Date(ends_at)   : null,
            'max_capacity_override' in req.body ? 1 : 0,
            max_capacity_override != null && max_capacity_override !== '' ? parseInt(max_capacity_override, 10) : null,
            gymMembershipId,
            req.params.id, gymId,
          ],
        );
      });

      const { rows } = await db.query(`${SELECT} WHERE cs.id = ? AND cs.gym_id = ?`, [req.params.id, gymId]);
      return res.json(rows[0]);
    }

    const { rowCount } = await db.query(
      `UPDATE class_sessions SET
        activity_type_id       = COALESCE(?, activity_type_id),
        trainer_membership_id  = IF(?, ?, trainer_membership_id),
        space_id               = IF(?, ?, space_id),
        starts_at              = COALESCE(?, starts_at),
        ends_at                = COALESCE(?, ends_at),
        max_capacity_override  = IF(?, ?, max_capacity_override),
        allows_shared_booking  = IF(?, ?, allows_shared_booking),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ?`,
      [
        activity_type_id ?? null,
        'trainer_membership_id' in req.body ? 1 : 0, trainer_membership_id ?? null,
        'space_id'              in req.body ? 1 : 0, space_id ?? null,
        starts_at ? new Date(starts_at) : null,
        ends_at   ? new Date(ends_at)   : null,
        'max_capacity_override' in req.body ? 1 : 0,
        max_capacity_override != null && max_capacity_override !== '' ? parseInt(max_capacity_override, 10) : null,
        'allows_shared_booking' in req.body ? 1 : 0, allows_shared_booking ? 1 : 0,
        gymMembershipId,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Session not found' });
    const { rows } = await db.query(`${SELECT} WHERE cs.id = ? AND cs.gym_id = ?`, [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code, host_session_id: e.host_session_id });
    next(e);
  }
});

/** #323: Toggle sharing authorization for a slot.
 *  Enabling allows a second eligible group to book directly.
 *  Disabling while concurrent sessions exist returns 409 — existing bookings are never cancelled. */
classSessionsRouter.put('/:id/sharing-authorized', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { authorized } = req.body;
  if (typeof authorized !== 'boolean') return res.status(400).json({ error: 'authorized (boolean) is required' });

  try {
    const { rows: sessionRows } = await db.query(
      `SELECT cs.id, cs.trainer_membership_id, cs.space_id, cs.starts_at, cs.ends_at
       FROM class_sessions cs WHERE cs.id = ? AND cs.gym_id = ? AND cs.deleted_at IS NULL`,
      [req.params.id, gymId],
    );
    if (sessionRows.length === 0) return res.status(404).json({ error: 'Session not found' });
    const session = sessionRows[0];

    if (!authorized && session.trainer_membership_id && session.space_id) {
      const { rows: concurrent } = await db.query(
        `SELECT COUNT(*) AS cnt FROM class_sessions cs
         WHERE cs.gym_id = ? AND cs.trainer_membership_id = ? AND cs.space_id = ?
           AND cs.starts_at = ? AND cs.ends_at = ?
           AND cs.status <> 'cancelled' AND cs.deleted_at IS NULL AND cs.id <> ?`,
        [gymId, session.trainer_membership_id, session.space_id, session.starts_at, session.ends_at, req.params.id],
      );
      if (Number(concurrent[0].cnt) > 0) {
        return res.status(409).json({
          error: 'Cannot disable sharing while concurrent sessions exist for this slot. Resolve the concurrent sessions first.',
          code: 'concurrent_sessions_exist',
        });
      }
    }

    await db.query(
      'UPDATE class_sessions SET allows_shared_booking = ?, modified_by_membership_id = ? WHERE id = ? AND gym_id = ?',
      [authorized ? 1 : 0, gymMembershipId, req.params.id, gymId],
    );

    recordAudit(req, { action: 'update', entityType: 'class_session', entityId: req.params.id, next: { allows_shared_booking: authorized } });
    const { rows } = await db.query(`${SELECT} WHERE cs.id = ? AND cs.gym_id = ?`, [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// P2.4: cancel is a status flip with a required reason — never a hard delete,
// so the session stays queryable for history and its bookings can cascade
// cancel (wired in P2.5).
classSessionsRouter.post('/:id/cancel', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const reason = String(req.body?.cancellation_reason ?? '').trim();
  if (!reason) return res.status(400).json({ error: 'cancellation_reason is required' });

  const { rows: sessionRows } = await db.query(
    `SELECT cs.id, cs.starts_at, at.name AS title
     FROM class_sessions cs
     JOIN activity_types at ON at.id = cs.activity_type_id
     WHERE cs.id = ? AND cs.gym_id = ? AND cs.status <> 'cancelled' AND cs.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (sessionRows.length === 0) return res.status(404).json({ error: 'Session not found or already cancelled' });

  const session = sessionRows[0];
  const { rowCount } = await db.query(
    "UPDATE class_sessions SET status = 'cancelled', cancellation_reason = ? WHERE id = ? AND gym_id = ?",
    [reason, req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Session not found or already cancelled' });

  // Notify all booked members fire-and-forget
  const { rows: bookedRows } = await db.query(
    "SELECT member_id FROM bookings WHERE class_session_id = ? AND gym_id = ? AND status = 'booked'",
    [req.params.id, gymId],
  );
  const memberIds = bookedRows.map((r: any) => r.member_id);
  sendBulkNotification(gymId, memberIds, 'event_cancelled', 'session', Number(req.params.id), {
    title: session.title,
    starts_at: session.starts_at,
    reason,
  });

  recordAudit(req, { action: 'cancel', entityType: 'class_session', entityId: req.params.id, next: { cancellation_reason: reason } });
  res.status(204).send();
});

/** #193: Bulk-mark all pending confirmed bookings as present. */
classSessionsRouter.post('/:id/bulk-present',
  requireRole('admin', 'front_desk', 'trainer_performance', 'trainer_perf_nutrition'),
  async (req, res) => {
    const { gymId, gymMembershipId } = getTenantContext(req);
    const { rows: session } = await db.query(
      "SELECT id FROM class_sessions WHERE id = ? AND gym_id = ? AND deleted_at IS NULL",
      [req.params.id, gymId],
    );
    if (session.length === 0) return res.status(404).json({ error: 'Session not found' });

    const { rowCount } = await db.query(
      `UPDATE bookings
       SET attendance_status = 'present',
           attendance_recorded_at = UTC_TIMESTAMP(),
           attendance_recorded_by_membership_id = ?,
           modified_at = UTC_TIMESTAMP(),
           modified_by_membership_id = ?
       WHERE class_session_id = ? AND gym_id = ? AND status = 'booked' AND attendance_status = 'pending'`,
      [gymMembershipId, gymMembershipId, req.params.id, gymId],
    );
    res.json({ updated: rowCount });
  },
);

/** #193: Set or clear the trainer who actually delivered the session. */
classSessionsRouter.put('/:id/effective-trainer', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { trainer_membership_id } = req.body;

  if (trainer_membership_id != null) {
    const { rows: trainerRows } = await db.query(
      "SELECT id FROM gym_memberships WHERE id = ? AND gym_id = ? AND role IN ('trainer_performance','trainer_perf_nutrition')",
      [trainer_membership_id, gymId],
    );
    if (trainerRows.length === 0) return res.status(404).json({ error: 'Trainer not found' });
  }

  const { rows: prev } = await db.query(
    'SELECT effective_trainer_membership_id FROM class_sessions WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (prev.length === 0) return res.status(404).json({ error: 'Session not found' });

  await db.query(
    `UPDATE class_sessions
     SET effective_trainer_membership_id = ?,
         effective_trainer_confirmed_at  = IF(? IS NOT NULL, UTC_TIMESTAMP(), effective_trainer_confirmed_at),
         modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ?`,
    [trainer_membership_id ?? null, trainer_membership_id ?? null, gymMembershipId, req.params.id, gymId],
  );

  recordAudit(req, {
    action: 'update',
    entityType: 'class_session',
    entityId: req.params.id,
    previous: { effective_trainer_membership_id: prev[0].effective_trainer_membership_id },
    next: { effective_trainer_membership_id: trainer_membership_id ?? null },
  });

  const { rows } = await db.query(`${SELECT} WHERE cs.id = ? AND cs.gym_id = ?`, [req.params.id, gymId]);
  res.json(rows[0]);
});

/** #193: Complete a session — hard-blocked until all confirmed bookings have attendance and a trainer is set. */
classSessionsRouter.post('/:id/complete', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);

  const { rows: sessionRows } = await db.query(
    'SELECT id, status, trainer_membership_id, effective_trainer_membership_id FROM class_sessions WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (sessionRows.length === 0) return res.status(404).json({ error: 'Session not found' });
  const session = sessionRows[0];

  if (session.status === 'completed') return res.status(400).json({ error: 'Session is already completed' });
  if (session.status === 'cancelled') return res.status(400).json({ error: 'Cancelled sessions cannot be completed' });

  const { rows: pendingRows } = await db.query(
    `SELECT COUNT(*) AS pending_count
     FROM bookings WHERE class_session_id = ? AND gym_id = ? AND status = 'booked' AND attendance_status = 'pending'`,
    [req.params.id, gymId],
  );
  const pendingCount = Number(pendingRows[0].pending_count);

  const missingTrainer = session.trainer_membership_id == null && session.effective_trainer_membership_id == null;

  if (pendingCount > 0 || missingTrainer) {
    return res.status(400).json({
      error: 'Cannot complete session',
      pending_count: pendingCount,
      missing_trainer: missingTrainer,
    });
  }

  await db.query(
    "UPDATE class_sessions SET status = 'completed', modified_by_membership_id = ? WHERE id = ? AND gym_id = ?",
    [gymMembershipId, req.params.id, gymId],
  );

  recordAudit(req, { action: 'complete', entityType: 'class_session', entityId: req.params.id, next: { status: 'completed' } });
  const { rows } = await db.query(`${SELECT} WHERE cs.id = ? AND cs.gym_id = ?`, [req.params.id, gymId]);
  res.json(rows[0]);
});
