import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireRole, requireModuleWrite } from '../infra/tenantContext';
import { handleDupEntry } from '../infra/db-helpers';
import { recordAudit } from '../infra/audit';
import { sendNotification } from '../infra/notifications';
// Late-imported by callers to avoid a cycle (package-credits imports registerBookingAccessHook).
let packageCreditsModule: typeof import('./package-credits') | null = null;
async function packageCredits() {
  if (!packageCreditsModule) packageCreditsModule = await import('./package-credits');
  return packageCreditsModule;
}

/**
 * P2.5 bookings: waitlist + attendance — now backed by calendar_event_bookings.
 *
 * API shapes are preserved: `class_session_id` in requests/responses maps to
 * `ceb.calendar_event_id`; stage-4 frontend migration will rename the field.
 */
const SELECT = `
  SELECT ceb.*,
         ceb.calendar_event_id AS class_session_id,
         m.name AS member_name, m.email AS member_email,
         ce.starts_at AS session_starts_at, ce.ends_at AS session_ends_at,
         ce.status AS session_status,
         at.name AS class_type_name,
         COALESCE(ce.capacity, at.max_capacity) AS effective_capacity
  FROM calendar_event_bookings ceb
  JOIN members m ON m.id = ceb.member_id
  JOIN calendar_events ce ON ce.id = ceb.calendar_event_id
  JOIN activity_types at ON at.id = ce.activity_type_id
`;

// Hook point for P2.7 (plan-access) and P3.3 (packages). Called inside the
// booking transaction with the tx handle; must throw an Error with a message
// the router can surface as a translated string.
export interface AccessHook {
  (tx: Tx, gymId: string, memberId: number, activityTypeId: number, centerId?: number | null): Promise<void>;
}
const accessHooks: AccessHook[] = [];
export function registerBookingAccessHook(fn: AccessHook) { accessHooks.push(fn); }

export const bookingsRouter = Router();

bookingsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { session_id, status } = req.query as Record<string, string | undefined>;
  const where: string[] = ['ceb.gym_id = ?'];
  const params: (string | number)[] = [gymId];
  if (session_id) { where.push('ceb.calendar_event_id = ?'); params.push(session_id); }
  if (status)     { where.push('ceb.status = ?'); params.push(status); }
  const { rows } = await db.query(
    `${SELECT} WHERE ${where.join(' AND ')}
     ORDER BY
       FIELD(ceb.status, 'booked','attended','no_show','waitlisted','cancelled'),
       ceb.waitlist_position IS NULL, ceb.waitlist_position ASC,
       ceb.booked_at ASC`,
    params,
  );
  res.json(rows);
});

bookingsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${SELECT} WHERE ceb.id = ? AND ceb.gym_id = ?`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
  res.json(rows[0]);
});

/**
 * Runs the booking flow inside a transaction; exported so /me/bookings can share it.
 * Pass force=true to allow adding a member even when the session is at capacity
 * (always inserts as 'booked', never waitlisted). Only staff-facing.
 */
export async function bookMemberOnSession(
  gymId: string,
  memberId: number,
  sessionId: number,
  force = false,
  forceWaitlist = false,
  existingTx?: Tx,
) {
  const run = async (tx: Tx) => {
    const { rows: session } = await tx.query(
      `SELECT ce.id, ce.activity_type_id, ce.status, ce.center_id,
              COALESCE(ce.capacity, at.max_capacity) AS effective_capacity
       FROM calendar_events ce
       JOIN activity_types at ON at.id = ce.activity_type_id
       WHERE ce.id = ? AND ce.gym_id = ? AND ce.kind = 'session' AND ce.deleted_at IS NULL FOR UPDATE`,
      [sessionId, gymId],
    );
    if (session.length === 0) throw Object.assign(new Error('Session not found'), { status: 404 });
    if (session[0].status !== 'scheduled') throw Object.assign(new Error('Session is not open for bookings'), { status: 400 });

    for (const hook of accessHooks) {
      await hook(tx, gymId, memberId, session[0].activity_type_id, session[0].center_id);
    }

    const { rows: nextRows } = await tx.query(
      `SELECT COALESCE(MAX(waitlist_position), 0) + 1 AS next
       FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'waitlisted'`,
      [sessionId],
    );

    if (forceWaitlist) {
      const position = Number(nextRows[0].next);
      const { insertId } = await tx.query(
        `INSERT INTO calendar_event_bookings (gym_id, center_id, member_id, calendar_event_id, status, waitlist_position, waitlisted_at)
         VALUES (?, ?, ?, ?, 'waitlisted', ?, UTC_TIMESTAMP())`,
        [gymId, session[0].center_id, memberId, sessionId, position],
      );
      return { id: insertId, status: 'waitlisted', waitlist_position: position, over_capacity: false };
    }

    const { rows: countRows } = await tx.query(
      `SELECT COUNT(*) AS booked FROM calendar_event_bookings WHERE calendar_event_id = ? AND status = 'booked'`,
      [sessionId],
    );
    const booked = Number(countRows[0].booked);
    const overCapacity = booked >= Number(session[0].effective_capacity);

    if (!overCapacity || force) {
      const { insertId } = await tx.query(
        `INSERT INTO calendar_event_bookings (gym_id, center_id, member_id, calendar_event_id, status, booked_at)
         VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`,
        [gymId, session[0].center_id, memberId, sessionId],
      );
      const pc = await packageCredits();
      await pc.debitPackageIfClaimed(tx, insertId, gymId);
      return { id: insertId, status: 'booked', waitlist_position: null, over_capacity: force && overCapacity };
    }

    const position = Number(nextRows[0].next);
    const { insertId } = await tx.query(
      `INSERT INTO calendar_event_bookings (gym_id, center_id, member_id, calendar_event_id, status, waitlist_position, waitlisted_at)
       VALUES (?, ?, ?, ?, 'waitlisted', ?, UTC_TIMESTAMP())`,
      [gymId, session[0].center_id, memberId, sessionId, position],
    );
    return { id: insertId, status: 'waitlisted', waitlist_position: position, over_capacity: false };
  };
  return existingTx ? run(existingTx) : db.transaction(run);
}

/** Cancel + promote the next waitlist row inside one transaction. */
export async function cancelBooking(gymId: string, bookingId: number, actorMembershipId?: number | null) {
  return db.transaction(async (tx) => {
    const { rows: bookingRows } = await tx.query(
      `SELECT ceb.id, ceb.member_id, ceb.calendar_event_id, ceb.status, ceb.user_class_package_id,
              ce.starts_at AS session_starts_at
       FROM calendar_event_bookings ceb
       JOIN calendar_events ce ON ce.id = ceb.calendar_event_id
       WHERE ceb.id = ? AND ceb.gym_id = ? FOR UPDATE`,
      [bookingId, gymId],
    );
    if (bookingRows.length === 0) throw Object.assign(new Error('Booking not found'), { status: 404 });
    const b = bookingRows[0];
    if (b.status === 'cancelled') throw Object.assign(new Error('Already cancelled'), { status: 400 });

    await tx.query(
      "UPDATE calendar_event_bookings SET status='cancelled', cancelled_at=UTC_TIMESTAMP(), modified_at=UTC_TIMESTAMP(), modified_by_membership_id=? WHERE id = ?",
      [actorMembershipId ?? null, bookingId],
    );

    if (b.user_class_package_id) {
      const { rows: dayRows } = await tx.query(
        'SELECT (? >= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY)) AS cancelled_in_advance',
        [b.session_starts_at],
      );
      const cancelledInAdvance = Number(dayRows[0].cancelled_in_advance) === 1;
      if (cancelledInAdvance) {
        const pc = await packageCredits();
        await pc.refundPackageCredit(tx, bookingId, b.user_class_package_id, gymId);
      }
    }

    if (b.status !== 'booked') return { promoted: null, promotedMemberId: null };

    const { rows: waitRows } = await tx.query(
      `SELECT id, member_id, waitlist_position FROM calendar_event_bookings
       WHERE calendar_event_id = ? AND status = 'waitlisted'
       ORDER BY waitlist_position ASC LIMIT 1 FOR UPDATE`,
      [b.calendar_event_id],
    );
    if (waitRows.length === 0) return { promoted: null, promotedMemberId: null };
    await tx.query(
      "UPDATE calendar_event_bookings SET status='booked', booked_at=UTC_TIMESTAMP(), waitlist_position=NULL WHERE id = ?",
      [waitRows[0].id],
    );

    const promotedMemberId = waitRows[0].member_id;
    const { rows: sessionRow } = await tx.query(
      'SELECT activity_type_id, center_id FROM calendar_events WHERE id = ?',
      [b.calendar_event_id],
    );
    for (const hook of accessHooks) {
      try { await hook(tx, gymId, promotedMemberId, sessionRow[0].activity_type_id, sessionRow[0].center_id); }
      catch { /* promotion never fails */ }
    }
    const pc = await packageCredits();
    await pc.debitPackageIfClaimed(tx, waitRows[0].id, gymId);

    return { promoted: waitRows[0].id, promotedMemberId: waitRows[0].member_id };
  });
}

bookingsRouter.post('/', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { member_id, class_session_id, force, waitlist } = req.body;
  if (!member_id || !class_session_id) {
    return res.status(400).json({ error: 'member_id and class_session_id are required' });
  }
  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [member_id, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  try {
    const result = await bookMemberOnSession(gymId, member_id, class_session_id, Boolean(force), Boolean(waitlist));
    const { rows } = await db.query(`${SELECT} WHERE ceb.id = ?`, [result.id]);
    res.status(201).json({ ...rows[0], over_capacity: result.over_capacity });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    handleDupEntry(err, res, next, 'This member already has an active booking for this session.');
  }
});

bookingsRouter.delete('/:id', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    const { rows: sessionRows } = await db.query<{ calendar_event_id: number; title: string; starts_at: string }>(
      `SELECT ceb.calendar_event_id, ce.starts_at, at.name AS title
         FROM calendar_event_bookings ceb
         JOIN calendar_events ce ON ce.id = ceb.calendar_event_id
         JOIN activity_types at ON at.id = ce.activity_type_id
        WHERE ceb.id = ? AND ceb.gym_id = ?`,
      [req.params.id, gymId],
    );
    const cancelResult = await cancelBooking(gymId, Number(req.params.id), gymMembershipId);
    if (cancelResult.promotedMemberId && sessionRows.length > 0) {
      sendNotification(gymId, cancelResult.promotedMemberId, 'promoted_from_waitlist', 'session',
        sessionRows[0].calendar_event_id, { title: sessionRows[0].title, starts_at: sessionRows[0].starts_at });
    }
    res.status(204).send();
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

bookingsRouter.post('/:id/attendance', requireRole('admin', 'front_desk', 'trainer_performance', 'trainer_perf_nutrition'), async (req, res) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { status } = req.body;
  if (!['present', 'absent'].includes(status)) {
    return res.status(400).json({ error: "status must be 'present' or 'absent'" });
  }

  const { rows: current } = await db.query(
    `SELECT attendance_status FROM calendar_event_bookings WHERE id = ? AND gym_id = ? AND status = 'booked'`,
    [req.params.id, gymId],
  );
  if (current.length === 0) {
    return res.status(404).json({ error: 'Booking not found or not eligible for attendance (must be booked, not waitlisted or cancelled)' });
  }

  await db.query(
    `UPDATE calendar_event_bookings
     SET attendance_status = ?,
         attendance_recorded_at = UTC_TIMESTAMP(),
         attendance_recorded_by_membership_id = ?,
         modified_at = UTC_TIMESTAMP(),
         modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ?`,
    [status, gymMembershipId, gymMembershipId, req.params.id, gymId],
  );

  const { rows } = await db.query(`${SELECT} WHERE ceb.id = ? AND ceb.gym_id = ?`, [req.params.id, gymId]);
  res.json(rows[0]);
});

/**
 * #372: explicit trainer/staff refund of a package credit kept consumed by a
 * same-day cancellation. Only cancelled bookings that still hold a package link
 * are eligible.
 */
bookingsRouter.post('/:id/refund-credit', requireRole('admin', 'front_desk', 'trainer_performance', 'trainer_perf_nutrition'), async (req, res, next) => {
  const { gymId, gymMembershipId, userId } = getTenantContext(req);
  try {
    const result = await db.transaction(async (tx) => {
      const { rows: bookingRows } = await tx.query(
        "SELECT id, status, user_class_package_id FROM calendar_event_bookings WHERE id = ? AND gym_id = ? FOR UPDATE",
        [req.params.id, gymId],
      );
      if (bookingRows.length === 0) throw Object.assign(new Error('Booking not found'), { status: 404 });
      const b = bookingRows[0];
      if (b.status !== 'cancelled' || !b.user_class_package_id) {
        throw Object.assign(new Error('Booking has no consumed package credit available to refund'), { status: 400 });
      }
      const pc = await packageCredits();
      await pc.refundPackageCredit(tx, b.id, b.user_class_package_id, gymId, 'Manual refund (same-day cancellation)', userId);
      return { userClassPackageId: b.user_class_package_id };
    });

    recordAudit(req, {
      action: 'refund_credit',
      entityType: 'booking',
      entityId: req.params.id,
      next: { user_class_package_id: result.userClassPackageId, actor_membership_id: gymMembershipId },
    });

    const { rows } = await db.query(`${SELECT} WHERE ceb.id = ? AND ceb.gym_id = ?`, [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
