/**
 * #360 stage 3: unified CalendarEvent routers.
 *
 * Both routers share the calendar_events table differentiated by the `kind`
 * column added in migration 134:
 *   - classSessionsRouter  → kind = 'session'  (was api/class-sessions.ts)
 *   - calendarEventsRouter → kind = 'event'    (original calendar-events.ts)
 *
 * Bookings for sessions live in calendar_event_bookings (migration 132).
 */
import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireModuleWrite, requireRole } from '../infra/tenantContext';
import { resolveCenterId } from '../infra/centerContext';
import { recordAudit } from '../infra/audit';
import { sendBulkNotification } from '../infra/notifications';
import { bookMemberOnSession } from './bookings';

// ─── Shared helpers ──────────────────────────────────────────────────────────

const SESSION_STATUSES = ['scheduled', 'cancelled', 'completed'] as const;
const EVENT_STATUSES   = ['draft', 'scheduled', 'completed', 'cancelled'] as const;

/** Interval overlap: new event [newStart, newEnd) overlaps existing if newStart < end AND newEnd > start */
async function checkConflict(
  gymId: string,
  field: 'space_id' | 'trainer_membership_id',
  resourceId: number,
  startsAt: string,
  endsAt: string,
  excludeId?: number,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM calendar_events
     WHERE gym_id = ? AND ${field} = ?
       AND status != 'cancelled'
       AND deleted_at IS NULL
       AND id != COALESCE(?, 0)
       AND starts_at < ? AND ends_at > ?`,
    [gymId, resourceId, excludeId ?? null, endsAt, startsAt],
  );
  return rows[0].cnt > 0;
}

// ─── classSessionsRouter ─────────────────────────────────────────────────────

/**
 * SELECT fragment for sessions. Produces the same response shape as the old
 * class_sessions-backed query so stage-4 frontend migration starts from a
 * stable baseline.  Key aliases:
 *   ce.capacity → max_capacity_override   (old field name kept for compat)
 */
const SESSION_SELECT = `
  SELECT ce.*,
         ce.capacity AS max_capacity_override,
         at.name AS class_type_name,
         at.color AS activity_type_color,
         at.max_capacity AS class_type_capacity,
         at.duration_minutes AS class_type_duration,
         at.is_shareable,
         COALESCE(ce.capacity, at.max_capacity) AS effective_capacity,
         sp.name AS space_name,
         gm.name AS trainer_name,
         COALESCE(sp.max_concurrent_groups, 1) AS space_max_concurrent_groups,
         COALESCE(gm.max_concurrent_groups, 1) AS trainer_max_concurrent_groups,
         CASE
           WHEN ce.trainer_membership_id IS NOT NULL AND ce.space_id IS NOT NULL
           THEN LEAST(COALESCE(gm.max_concurrent_groups, 1), COALESCE(sp.max_concurrent_groups, 1))
           ELSE 1
         END AS effective_max_groups,
         CASE
           WHEN ce.trainer_membership_id IS NOT NULL AND ce.space_id IS NOT NULL
           THEN (
             SELECT COUNT(*) FROM calendar_events ce2
             WHERE ce2.gym_id = ce.gym_id
               AND ce2.trainer_membership_id = ce.trainer_membership_id
               AND ce2.space_id = ce.space_id
               AND ce2.starts_at = ce.starts_at
               AND ce2.ends_at = ce.ends_at
               AND ce2.kind = 'session'
               AND ce2.status <> 'cancelled'
               AND ce2.deleted_at IS NULL
           )
           ELSE 1
         END AS concurrent_groups_count,
         etm.name AS effective_trainer_name,
         (SELECT COUNT(*) FROM calendar_event_bookings ceb WHERE ceb.calendar_event_id = ce.id AND ceb.status = 'booked') AS booked_count,
         (SELECT COUNT(*) FROM calendar_event_bookings ceb WHERE ceb.calendar_event_id = ce.id AND ceb.status = 'booked' AND ceb.attendance_status = 'present')  AS attendance_present,
         (SELECT COUNT(*) FROM calendar_event_bookings ceb WHERE ceb.calendar_event_id = ce.id AND ceb.status = 'booked' AND ceb.attendance_status = 'absent')   AS attendance_absent,
         (SELECT COUNT(*) FROM calendar_event_bookings ceb WHERE ceb.calendar_event_id = ce.id AND ceb.status = 'booked' AND ceb.attendance_status = 'pending')  AS attendance_pending
  FROM calendar_events ce
  JOIN activity_types at ON at.id = ce.activity_type_id
  LEFT JOIN spaces sp ON sp.id = ce.space_id
  LEFT JOIN gym_memberships gm  ON gm.id  = ce.trainer_membership_id
  LEFT JOIN gym_memberships etm ON etm.id = ce.effective_trainer_membership_id
`;

export const classSessionsRouter = Router();

classSessionsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { from, to, status, center_id, activity_type_id, space_id, trainer_membership_id } = req.query as Record<string, string | undefined>;
  const where: string[] = ["ce.gym_id = ?", "ce.kind = 'session'", 'ce.deleted_at IS NULL'];
  const params: any[] = [gymId];
  if (from)                 { where.push('ce.starts_at >= ?');              params.push(from); }
  if (to)                   { where.push('ce.starts_at <= ?');              params.push(to); }
  if (status && SESSION_STATUSES.includes(status as any)) { where.push('ce.status = ?'); params.push(status); }
  if (center_id)            { where.push('ce.center_id = ?');              params.push(center_id); }
  if (activity_type_id)     { where.push('ce.activity_type_id = ?');       params.push(activity_type_id); }
  if (space_id)             { where.push('ce.space_id = ?');               params.push(space_id); }
  if (trainer_membership_id){ where.push('ce.trainer_membership_id = ?'); params.push(trainer_membership_id); }
  const { rows } = await db.query(
    `${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY ce.starts_at ASC`,
    params,
  );
  res.json(rows);
});

classSessionsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SESSION_SELECT} WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'session' AND ce.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });
  res.json(rows[0]);
});

async function validateSessionRefs(gymId: string, body: any, centerId: number) {
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
    if (rows[0].center_id !== centerId) return "Space does not belong to this session's center";
  }
  return null;
}

/**
 * #366: normalize + validate the optional `member_ids` field on session
 * creation — staff assigning Members directly (they become normal
 * calendar_event_bookings via the same force=true mechanism used for a
 * manual add, so capacity is never a hard block for staff).
 */
function normalizeMemberIds(body: any): number[] | string {
  if (!('member_ids' in body) || body.member_ids == null) return [];
  if (!Array.isArray(body.member_ids)) return 'member_ids must be an array of member ids';
  const ids: number[] = body.member_ids.map(Number);
  if (ids.some((id: number) => !Number.isInteger(id) || id <= 0)) return 'member_ids must contain positive integers';
  return [...new Set(ids)];
}

async function validateMemberIds(gymId: string, memberIds: number[]): Promise<string | null> {
  if (memberIds.length === 0) return null;
  const { rows } = await db.query(
    `SELECT id FROM members WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${memberIds.map(() => '?').join(',')})`,
    [gymId, ...memberIds],
  );
  if (rows.length !== memberIds.length) return 'One or more member_ids were not found for this gym';
  return null;
}

classSessionsRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
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

  const memberIds = normalizeMemberIds(req.body);
  if (typeof memberIds === 'string') return res.status(400).json({ error: memberIds });

  try {
    const resolvedCenterId = await resolveCenterId(gymId, req, center_id);
    const err = await validateSessionRefs(gymId, req.body, resolvedCenterId);
    if (err) return res.status(err.includes('inactive') || err.includes('center') ? 400 : 404).json({ error: err });

    const memberErr = await validateMemberIds(gymId, memberIds);
    if (memberErr) return res.status(400).json({ error: memberErr });

    // Fetch activity type name for the title field (required on calendar_events).
    const { rows: atRows2 } = await db.query(
      'SELECT name, is_shareable FROM activity_types WHERE id = ? AND gym_id = ?',
      [activity_type_id, gymId],
    );
    const activityTitle = atRows2[0]?.name ?? '';
    const newShareable = !!atRows2[0]?.is_shareable;

    const trainerId  = trainer_membership_id ?? null;
    const spaceIdVal = space_id ?? null;
    const startsAtDate = new Date(starts_at);
    const endsAtDate   = new Date(ends_at);

    if (trainerId && spaceIdVal) {
      const row = await db.transaction(async (tx) => {
        const { rows: existing } = await tx.query(
          `SELECT ce.id, at.is_shareable AS act_shareable, ce.allows_shared_booking,
                  COALESCE(gm.max_concurrent_groups, 1) AS trainer_max,
                  COALESCE(sp.max_concurrent_groups, 1) AS space_max
           FROM calendar_events ce
           JOIN activity_types at ON at.id = ce.activity_type_id
           JOIN gym_memberships gm ON gm.id = ce.trainer_membership_id
           JOIN spaces sp ON sp.id = ce.space_id
           WHERE ce.gym_id = ? AND ce.trainer_membership_id = ? AND ce.space_id = ?
             AND ce.starts_at = ? AND ce.ends_at = ?
             AND ce.kind = 'session'
             AND ce.status <> 'cancelled' AND ce.deleted_at IS NULL
           FOR UPDATE`,
          [gymId, trainerId, spaceIdVal, startsAtDate, endsAtDate],
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

        const { insertId } = await tx.query(
          `INSERT INTO calendar_events
           (gym_id, center_id, kind, title, activity_type_id, trainer_membership_id, space_id,
            starts_at, ends_at, capacity, created_by_membership_id, modified_by_membership_id)
           VALUES (?, ?, 'session', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [gymId, resolvedCenterId, activityTitle, activity_type_id, trainerId, spaceIdVal,
           startsAtDate, endsAtDate, cap, gymMembershipId, gymMembershipId],
        );
        for (const memberId of memberIds) {
          await bookMemberOnSession(gymId, memberId, insertId, true, false, tx);
        }
        const { rows } = await tx.query(
          `${SESSION_SELECT} WHERE ce.id = ?`,
          [insertId],
        );
        return rows[0];
      });

      recordAudit(req, { action: 'create', entityType: 'class_session', entityId: row.id, next: row });
      return res.status(201).json(row);
    }

    const row = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO calendar_events
         (gym_id, center_id, kind, title, activity_type_id, trainer_membership_id, space_id,
          starts_at, ends_at, capacity, created_by_membership_id, modified_by_membership_id)
         VALUES (?, ?, 'session', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, resolvedCenterId, activityTitle, activity_type_id, trainerId, spaceIdVal,
         startsAtDate, endsAtDate, cap, gymMembershipId, gymMembershipId],
      );
      for (const memberId of memberIds) {
        await bookMemberOnSession(gymId, memberId, insertId, true, false, tx);
      }
      const { rows } = await tx.query(`${SESSION_SELECT} WHERE ce.id = ?`, [insertId]);
      return rows[0];
    });
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
      `SELECT ce.center_id, ce.trainer_membership_id AS cur_trainer, ce.space_id AS cur_space,
              ce.starts_at AS cur_starts, ce.ends_at AS cur_ends, ce.activity_type_id AS cur_activity
       FROM calendar_events ce WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'session' AND ce.deleted_at IS NULL`,
      [req.params.id, gymId],
    );
    if (existingRows.length === 0) return res.status(404).json({ error: 'Session not found' });
    const cur = existingRows[0];

    const err = await validateSessionRefs(gymId, req.body, cur.center_id);
    if (err) return res.status(err.includes('inactive') || err.includes('center') ? 400 : 404).json({ error: err });

    const effTrainer  = 'trainer_membership_id' in req.body ? (trainer_membership_id ?? null) : cur.cur_trainer;
    const effSpace    = 'space_id'               in req.body ? (space_id ?? null)               : cur.cur_space;
    const effStarts   = starts_at ? new Date(starts_at) : cur.cur_starts;
    const effEnds     = ends_at   ? new Date(ends_at)   : cur.cur_ends;
    const effActivity = 'activity_type_id' in req.body ? activity_type_id : cur.cur_activity;

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
        const { rows: existing } = await tx.query(
          `SELECT ce.id, at.is_shareable AS act_shareable, ce.allows_shared_booking,
                  COALESCE(gm.max_concurrent_groups, 1) AS trainer_max,
                  COALESCE(sp.max_concurrent_groups, 1) AS space_max
           FROM calendar_events ce
           JOIN activity_types at ON at.id = ce.activity_type_id
           JOIN gym_memberships gm ON gm.id = ce.trainer_membership_id
           JOIN spaces sp ON sp.id = ce.space_id
           WHERE ce.gym_id = ? AND ce.trainer_membership_id = ? AND ce.space_id = ?
             AND ce.starts_at = ? AND ce.ends_at = ?
             AND ce.kind = 'session'
             AND ce.status <> 'cancelled' AND ce.deleted_at IS NULL
             AND ce.id <> ?
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
          `UPDATE calendar_events SET
            activity_type_id      = COALESCE(?, activity_type_id),
            trainer_membership_id = IF(?, ?, trainer_membership_id),
            space_id              = IF(?, ?, space_id),
            starts_at             = COALESCE(?, starts_at),
            ends_at               = COALESCE(?, ends_at),
            capacity              = IF(?, ?, capacity),
            modified_by_membership_id = ?
           WHERE id = ? AND gym_id = ? AND kind = 'session'`,
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

      const { rows } = await db.query(
        `${SESSION_SELECT} WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'session'`,
        [req.params.id, gymId],
      );
      return res.json(rows[0]);
    }

    const { rowCount } = await db.query(
      `UPDATE calendar_events SET
        activity_type_id       = COALESCE(?, activity_type_id),
        trainer_membership_id  = IF(?, ?, trainer_membership_id),
        space_id               = IF(?, ?, space_id),
        starts_at              = COALESCE(?, starts_at),
        ends_at                = COALESCE(?, ends_at),
        capacity               = IF(?, ?, capacity),
        allows_shared_booking  = IF(?, ?, allows_shared_booking),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND kind = 'session'`,
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
    const { rows } = await db.query(
      `${SESSION_SELECT} WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'session'`,
      [req.params.id, gymId],
    );
    res.json(rows[0]);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code, host_session_id: e.host_session_id });
    next(e);
  }
});

classSessionsRouter.put('/:id/sharing-authorized', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { authorized } = req.body;
  if (typeof authorized !== 'boolean') return res.status(400).json({ error: 'authorized (boolean) is required' });

  try {
    const { rows: sessionRows } = await db.query(
      `SELECT ce.id, ce.trainer_membership_id, ce.space_id, ce.starts_at, ce.ends_at
       FROM calendar_events ce WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'session' AND ce.deleted_at IS NULL`,
      [req.params.id, gymId],
    );
    if (sessionRows.length === 0) return res.status(404).json({ error: 'Session not found' });
    const session = sessionRows[0];

    if (!authorized && session.trainer_membership_id && session.space_id) {
      const { rows: concurrent } = await db.query(
        `SELECT COUNT(*) AS cnt FROM calendar_events ce
         WHERE ce.gym_id = ? AND ce.trainer_membership_id = ? AND ce.space_id = ?
           AND ce.starts_at = ? AND ce.ends_at = ?
           AND ce.kind = 'session'
           AND ce.status <> 'cancelled' AND ce.deleted_at IS NULL AND ce.id <> ?`,
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
      `UPDATE calendar_events SET allows_shared_booking = ?, modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND kind = 'session'`,
      [authorized ? 1 : 0, gymMembershipId, req.params.id, gymId],
    );

    recordAudit(req, { action: 'update', entityType: 'class_session', entityId: req.params.id, next: { allows_shared_booking: authorized } });
    const { rows } = await db.query(
      `${SESSION_SELECT} WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'session'`,
      [req.params.id, gymId],
    );
    res.json(rows[0]);
  } catch (e) { next(e); }
});

classSessionsRouter.post('/:id/cancel', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const reason = String(req.body?.cancellation_reason ?? '').trim();
  if (!reason) return res.status(400).json({ error: 'cancellation_reason is required' });

  const { rows: sessionRows } = await db.query(
    `SELECT ce.id, ce.starts_at, at.name AS title
     FROM calendar_events ce
     JOIN activity_types at ON at.id = ce.activity_type_id
     WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'session' AND ce.status <> 'cancelled' AND ce.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (sessionRows.length === 0) return res.status(404).json({ error: 'Session not found or already cancelled' });

  const session = sessionRows[0];
  const { rowCount } = await db.query(
    "UPDATE calendar_events SET status = 'cancelled', cancellation_reason = ? WHERE id = ? AND gym_id = ? AND kind = 'session'",
    [reason, req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Session not found or already cancelled' });

  const { rows: bookedRows } = await db.query(
    "SELECT member_id FROM calendar_event_bookings WHERE calendar_event_id = ? AND gym_id = ? AND status = 'booked'",
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

classSessionsRouter.post('/:id/bulk-present',
  requireRole('admin', 'front_desk', 'trainer_performance', 'trainer_perf_nutrition'),
  async (req, res) => {
    const { gymId, gymMembershipId } = getTenantContext(req);
    const { rows: session } = await db.query(
      "SELECT id FROM calendar_events WHERE id = ? AND gym_id = ? AND kind = 'session' AND deleted_at IS NULL",
      [req.params.id, gymId],
    );
    if (session.length === 0) return res.status(404).json({ error: 'Session not found' });

    const { rowCount } = await db.query(
      `UPDATE calendar_event_bookings
       SET attendance_status = 'present',
           attendance_recorded_at = UTC_TIMESTAMP(),
           attendance_recorded_by_membership_id = ?,
           modified_at = UTC_TIMESTAMP(),
           modified_by_membership_id = ?
       WHERE calendar_event_id = ? AND gym_id = ? AND status = 'booked' AND attendance_status = 'pending'`,
      [gymMembershipId, gymMembershipId, req.params.id, gymId],
    );
    res.json({ updated: rowCount });
  },
);

classSessionsRouter.post('/:id/walk-in',
  requireRole('admin', 'front_desk', 'trainer_performance', 'trainer_perf_nutrition'),
  async (req, res, next) => {
    const { gymId, gymMembershipId } = getTenantContext(req);
    const { member_id } = req.body;
    if (!member_id) return res.status(400).json({ error: 'member_id is required' });

    try {
      const { rows: memberRows } = await db.query(
        'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
        [member_id, gymId],
      );
      if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

      const bookingId = await db.transaction(async (tx) => {
        const { rows: existing } = await tx.query(
          "SELECT id FROM calendar_event_bookings WHERE calendar_event_id = ? AND member_id = ? AND status <> 'cancelled' FOR UPDATE",
          [req.params.id, member_id],
        );
        if (existing.length > 0) {
          throw Object.assign(new Error('Member already has an active booking for this session — use the attendance endpoint instead'), { status: 409 });
        }

        const booking = await bookMemberOnSession(gymId, member_id, Number(req.params.id), true, false, tx);
        await tx.query(
          `UPDATE calendar_event_bookings
           SET attendance_status = 'present',
               attendance_recorded_at = UTC_TIMESTAMP(),
               attendance_recorded_by_membership_id = ?,
               modified_at = UTC_TIMESTAMP(),
               modified_by_membership_id = ?
           WHERE id = ?`,
          [gymMembershipId, gymMembershipId, booking.id],
        );
        return booking.id;
      });

      const { rows } = await db.query(
        `${SESSION_SELECT} WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'session'`,
        [req.params.id, gymId],
      );
      res.status(201).json({ booking_id: bookingId, session: rows[0] });
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
);

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
    "SELECT effective_trainer_membership_id FROM calendar_events WHERE id = ? AND gym_id = ? AND kind = 'session' AND deleted_at IS NULL",
    [req.params.id, gymId],
  );
  if (prev.length === 0) return res.status(404).json({ error: 'Session not found' });

  await db.query(
    `UPDATE calendar_events
     SET effective_trainer_membership_id = ?,
         effective_trainer_confirmed_at  = IF(? IS NOT NULL, UTC_TIMESTAMP(), effective_trainer_confirmed_at),
         modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ? AND kind = 'session'`,
    [trainer_membership_id ?? null, trainer_membership_id ?? null, gymMembershipId, req.params.id, gymId],
  );

  recordAudit(req, {
    action: 'update',
    entityType: 'class_session',
    entityId: req.params.id,
    previous: { effective_trainer_membership_id: prev[0].effective_trainer_membership_id },
    next: { effective_trainer_membership_id: trainer_membership_id ?? null },
  });

  const { rows } = await db.query(
    `${SESSION_SELECT} WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'session'`,
    [req.params.id, gymId],
  );
  res.json(rows[0]);
});

classSessionsRouter.post('/:id/complete', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);

  const { rows: sessionRows } = await db.query(
    "SELECT id, status, trainer_membership_id, effective_trainer_membership_id FROM calendar_events WHERE id = ? AND gym_id = ? AND kind = 'session' AND deleted_at IS NULL",
    [req.params.id, gymId],
  );
  if (sessionRows.length === 0) return res.status(404).json({ error: 'Session not found' });
  const session = sessionRows[0];

  if (session.status === 'completed') return res.status(400).json({ error: 'Session is already completed' });
  if (session.status === 'cancelled') return res.status(400).json({ error: 'Cancelled sessions cannot be completed' });

  const { rows: pendingRows } = await db.query(
    `SELECT COUNT(*) AS pending_count
     FROM calendar_event_bookings WHERE calendar_event_id = ? AND gym_id = ? AND status = 'booked' AND attendance_status = 'pending'`,
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
    "UPDATE calendar_events SET status = 'completed', modified_by_membership_id = ? WHERE id = ? AND gym_id = ? AND kind = 'session'",
    [gymMembershipId, req.params.id, gymId],
  );

  recordAudit(req, { action: 'complete', entityType: 'class_session', entityId: req.params.id, next: { status: 'completed' } });
  const { rows } = await db.query(
    `${SESSION_SELECT} WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'session'`,
    [req.params.id, gymId],
  );
  res.json(rows[0]);
});

// ─── calendarEventsRouter ─────────────────────────────────────────────────────

const EVENT_SELECT = `
  SELECT
    ce.*,
    at.name   AS activity_type_name,
    at.color  AS activity_type_color,
    sp.name   AS space_name,
    gm.name   AS trainer_name,
    gm2.name  AS created_by_name,
    gm3.name  AS modified_by_name,
    gm4.name  AS deleted_by_name
  FROM calendar_events ce
  LEFT JOIN activity_types  at   ON at.id   = ce.activity_type_id
  LEFT JOIN spaces           sp  ON sp.id   = ce.space_id
  LEFT JOIN gym_memberships gm   ON gm.id   = ce.trainer_membership_id
  LEFT JOIN gym_memberships gm2  ON gm2.id  = ce.created_by_membership_id
  LEFT JOIN gym_memberships gm3  ON gm3.id  = ce.modified_by_membership_id
  LEFT JOIN gym_memberships gm4  ON gm4.id  = ce.deleted_by_membership_id
`;

export const calendarEventsRouter = Router();

calendarEventsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { from, to, space_id, activity_type_id, trainer_membership_id } = req.query;

  const params: any[] = [gymId];
  let sql = `${EVENT_SELECT} WHERE ce.gym_id = ? AND ce.kind = 'event' AND ce.deleted_at IS NULL`;

  if (from)                 { sql += ' AND ce.ends_at >= ?';              params.push(from); }
  if (to)                   { sql += ' AND ce.starts_at <= ?';            params.push(to); }
  if (space_id)             { sql += ' AND ce.space_id = ?';              params.push(space_id); }
  if (activity_type_id)     { sql += ' AND ce.activity_type_id = ?';      params.push(activity_type_id); }
  if (trainer_membership_id){ sql += ' AND ce.trainer_membership_id = ?'; params.push(trainer_membership_id); }

  sql += ' ORDER BY ce.starts_at ASC';
  const { rows } = await db.query(sql, params);
  res.json(rows);
});

calendarEventsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${EVENT_SELECT} WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'event' AND ce.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Calendar event not found' });
  res.json(rows[0]);
});

calendarEventsRouter.post('/', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const {
    title, activity_type_id, space_id, trainer_membership_id, color,
    starts_at, ends_at, all_day, description, status,
  } = req.body;

  if (!title?.trim())  return res.status(400).json({ error: 'title is required' });
  if (!starts_at)      return res.status(400).json({ error: 'starts_at is required' });
  if (!ends_at)        return res.status(400).json({ error: 'ends_at is required' });
  if (new Date(ends_at) <= new Date(starts_at)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  if (status && !EVENT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${EVENT_STATUSES.join(', ')}` });
  }

  if (space_id) {
    const conflict = await checkConflict(gymId, 'space_id', space_id, starts_at, ends_at);
    if (conflict) return res.status(409).json({ error: 'Space is already booked during this time.' });
  }
  if (trainer_membership_id) {
    const conflict = await checkConflict(gymId, 'trainer_membership_id', trainer_membership_id, starts_at, ends_at);
    if (conflict) return res.status(409).json({ error: 'Trainer is already assigned to another event during this time.' });
  }

  try {
    const { insertId } = await db.query(
      `INSERT INTO calendar_events
       (gym_id, kind, title, activity_type_id, space_id, trainer_membership_id, color,
        starts_at, ends_at, all_day, description, status, created_by_membership_id, modified_by_membership_id)
       VALUES (?, 'event', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, title.trim(), activity_type_id ?? null, space_id ?? null,
       trainer_membership_id ?? null, color ?? null,
       starts_at, ends_at, all_day ? 1 : 0,
       description ?? null, status ?? 'scheduled',
       gymMembershipId ?? null, gymMembershipId ?? null],
    );
    const { rows } = await db.query(`${EVENT_SELECT} WHERE ce.id = ?`, [insertId]);
    recordAudit(req, { action: 'create', entityType: 'calendar_event', entityId: String(insertId), entityName: title.trim(), next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (e: any) {
    next(e);
  }
});

calendarEventsRouter.put('/:id', requireModuleWrite('TRAINING'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: existing } = await db.query(
    "SELECT * FROM calendar_events WHERE id = ? AND gym_id = ? AND kind = 'event' AND deleted_at IS NULL",
    [req.params.id, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Calendar event not found' });

  const {
    title, activity_type_id, space_id, trainer_membership_id, color,
    starts_at, ends_at, all_day, description, status,
  } = req.body;

  const newStartsAt = starts_at ?? existing[0].starts_at;
  const newEndsAt   = ends_at   ?? existing[0].ends_at;

  if (new Date(newEndsAt) <= new Date(newStartsAt)) {
    return res.status(400).json({ error: 'ends_at must be after starts_at' });
  }
  if (status && !EVENT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${EVENT_STATUSES.join(', ')}` });
  }

  const resolvedSpaceId   = 'space_id'              in req.body ? (space_id ?? null)              : existing[0].space_id;
  const resolvedTrainerId = 'trainer_membership_id' in req.body ? (trainer_membership_id ?? null) : existing[0].trainer_membership_id;
  const selfId = Number(req.params.id);

  if (resolvedSpaceId) {
    const conflict = await checkConflict(gymId, 'space_id', resolvedSpaceId, newStartsAt, newEndsAt, selfId);
    if (conflict) return res.status(409).json({ error: 'Space is already booked during this time.' });
  }
  if (resolvedTrainerId) {
    const conflict = await checkConflict(gymId, 'trainer_membership_id', resolvedTrainerId, newStartsAt, newEndsAt, selfId);
    if (conflict) return res.status(409).json({ error: 'Trainer is already assigned to another event during this time.' });
  }

  try {
    await db.query(
      `UPDATE calendar_events SET
        title                  = COALESCE(?, title),
        activity_type_id       = IF(?, ?, activity_type_id),
        space_id               = IF(?, ?, space_id),
        trainer_membership_id  = IF(?, ?, trainer_membership_id),
        color                  = IF(?, ?, color),
        starts_at              = COALESCE(?, starts_at),
        ends_at                = COALESCE(?, ends_at),
        all_day                = COALESCE(?, all_day),
        description            = IF(?, ?, description),
        status                 = COALESCE(?, status),
        modified_by_membership_id = ?
       WHERE id = ? AND gym_id = ? AND kind = 'event' AND deleted_at IS NULL`,
      [
        title?.trim() ?? null,
        'activity_type_id'      in req.body ? 1 : 0, activity_type_id ?? null,
        'space_id'              in req.body ? 1 : 0, space_id ?? null,
        'trainer_membership_id' in req.body ? 1 : 0, trainer_membership_id ?? null,
        'color'                 in req.body ? 1 : 0, color ?? null,
        starts_at ?? null,
        ends_at   ?? null,
        all_day != null ? (all_day ? 1 : 0) : null,
        'description' in req.body ? 1 : 0, description ?? null,
        status ?? null,
        gymMembershipId ?? null,
        req.params.id, gymId,
      ],
    );
    const { rows } = await db.query(`${EVENT_SELECT} WHERE ce.id = ?`, [req.params.id]);
    recordAudit(req, { action: 'update', entityType: 'calendar_event', entityId: req.params.id, entityName: rows[0].title, next: rows[0] });
    res.json(rows[0]);
  } catch (e: any) {
    next(e);
  }
});

calendarEventsRouter.delete('/:id', requireModuleWrite('TRAINING'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { rows: existing } = await db.query(
    "SELECT title FROM calendar_events WHERE id = ? AND gym_id = ? AND kind = 'event' AND deleted_at IS NULL",
    [req.params.id, gymId],
  );
  if (existing.length === 0) return res.status(404).json({ error: 'Calendar event not found' });

  await db.query(
    `UPDATE calendar_events SET deleted_at = UTC_TIMESTAMP(), deleted_by_membership_id = ?
     WHERE id = ? AND gym_id = ? AND kind = 'event'`,
    [gymMembershipId ?? null, req.params.id, gymId],
  );
  recordAudit(req, { action: 'delete', entityType: 'calendar_event', entityId: req.params.id, entityName: existing[0].title });
  res.status(204).send();
});
