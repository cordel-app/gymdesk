import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
// Late-imported by callers to avoid a cycle (package-credits imports registerBookingAccessHook).
let packageCreditsModule: typeof import('./package-credits') | null = null;
async function packageCredits() {
  if (!packageCreditsModule) packageCreditsModule = await import('./package-credits');
  return packageCreditsModule;
}

/**
 * P2.5 bookings: waitlist + attendance.
 * Booking creation is transactional:
 *   1. SELECT ... FOR UPDATE on the session to serialise concurrent inserts.
 *   2. Count non-cancelled bookings on that session.
 *   3. If under effective capacity → status='booked', booked_at=UTC_TIMESTAMP().
 *      Else → status='waitlisted' with next waitlist_position.
 * Duplicate active bookings (same member × same session, non-cancelled) hit
 * the unique index and return 409.
 */
const SELECT = `
  SELECT b.*, m.name AS member_name, m.email AS member_email,
         cs.starts_at AS session_starts_at, cs.ends_at AS session_ends_at,
         cs.status AS session_status,
         at.name AS class_type_name,
         COALESCE(cs.max_capacity_override, at.max_capacity) AS effective_capacity
  FROM bookings b
  JOIN members m ON m.id = b.member_id
  JOIN class_sessions cs ON cs.id = b.class_session_id
  JOIN activity_types at ON at.id = cs.activity_type_id
`;

// Hook point for P2.7 (plan-access) and P3.3 (packages). Called inside the
// booking transaction with the tx handle; must throw an Error with a message
// the router can surface as a translated string.
export interface AccessHook {
  (tx: any, gymId: string, memberId: number, activityTypeId: number, centerId?: number | null): Promise<void>;
}
const accessHooks: AccessHook[] = [];
export function registerBookingAccessHook(fn: AccessHook) { accessHooks.push(fn); }

export const bookingsRouter = Router();

bookingsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { session_id, status } = req.query as Record<string, string | undefined>;
  const where: string[] = ['b.gym_id = ?'];
  const params: any[] = [gymId];
  if (session_id) { where.push('b.class_session_id = ?'); params.push(session_id); }
  if (status)     { where.push('b.status = ?'); params.push(status); }
  const { rows } = await db.query(
    `${SELECT} WHERE ${where.join(' AND ')}
     ORDER BY
       FIELD(b.status, 'booked','attended','no_show','waitlisted','cancelled'),
       b.waitlist_position IS NULL, b.waitlist_position ASC,
       b.booked_at ASC`,
    params,
  );
  res.json(rows);
});

bookingsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${SELECT} WHERE b.id = ? AND b.gym_id = ?`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
  res.json(rows[0]);
});

/** Runs the booking flow inside a transaction; exported so /me/bookings can share it. */
export async function bookMemberOnSession(gymId: string, memberId: number, sessionId: number) {
  return db.transaction(async (tx) => {
    const { rows: session } = await tx.query(
      `SELECT cs.id, cs.activity_type_id, cs.status, cs.center_id,
              COALESCE(cs.max_capacity_override, at.max_capacity) AS effective_capacity
       FROM class_sessions cs
       JOIN activity_types at ON at.id = cs.activity_type_id
       WHERE cs.id = ? AND cs.gym_id = ? AND cs.deleted_at IS NULL FOR UPDATE`,
      [sessionId, gymId],
    );
    if (session.length === 0) throw Object.assign(new Error('Session not found'), { status: 404 });
    if (session[0].status !== 'scheduled') throw Object.assign(new Error('Session is not open for bookings'), { status: 400 });

    // Run access hooks (plan-access, packages) — they can throw with .status/.message.
    for (const hook of accessHooks) {
      await hook(tx, gymId, memberId, session[0].activity_type_id, session[0].center_id);
    }

    const { rows: countRows } = await tx.query(
      `SELECT COUNT(*) AS booked
       FROM bookings
       WHERE class_session_id = ? AND status IN ('booked','attended','no_show')`,
      [sessionId],
    );
    const booked = Number(countRows[0].booked);
    if (booked < Number(session[0].effective_capacity)) {
      const { insertId } = await tx.query(
        `INSERT INTO bookings (gym_id, center_id, member_id, class_session_id, status, booked_at)
         VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`,
        [gymId, session[0].center_id, memberId, sessionId],
      );
      // P3.3: settle a package debit if one was claimed by the access hook.
      const pc = await packageCredits();
      await pc.debitPackageIfClaimed(tx, insertId, gymId);
      return { id: insertId, status: 'booked', waitlist_position: null };
    }

    const { rows: nextRows } = await tx.query(
      `SELECT COALESCE(MAX(waitlist_position), 0) + 1 AS next
       FROM bookings WHERE class_session_id = ? AND status = 'waitlisted'`,
      [sessionId],
    );
    const position = Number(nextRows[0].next);
    const { insertId } = await tx.query(
      `INSERT INTO bookings (gym_id, center_id, member_id, class_session_id, status, waitlist_position, waitlisted_at)
       VALUES (?, ?, ?, ?, 'waitlisted', ?, UTC_TIMESTAMP())`,
      [gymId, session[0].center_id, memberId, sessionId, position],
    );
    return { id: insertId, status: 'waitlisted', waitlist_position: position };
  });
}

/** Cancel + promote the next waitlist row inside one transaction. */
export async function cancelBooking(gymId: string, bookingId: number, actorMembershipId?: number | null) {
  return db.transaction(async (tx) => {
    const { rows: bookingRows } = await tx.query(
      "SELECT id, member_id, class_session_id, status, user_class_package_id FROM bookings WHERE id = ? AND gym_id = ? FOR UPDATE",
      [bookingId, gymId],
    );
    if (bookingRows.length === 0) throw Object.assign(new Error('Booking not found'), { status: 404 });
    const b = bookingRows[0];
    if (b.status === 'cancelled') throw Object.assign(new Error('Already cancelled'), { status: 400 });

    await tx.query(
      "UPDATE bookings SET status='cancelled', cancelled_at=UTC_TIMESTAMP(), modified_at=UTC_TIMESTAMP(), modified_by_membership_id=? WHERE id = ?",
      [actorMembershipId ?? null, bookingId],
    );

    // P3.3: refund the credit if this booking spent one. no_show is handled by
    // the attendance route, not here — the row stays 'no_show' and keeps the debit.
    if (b.user_class_package_id) {
      const pc = await packageCredits();
      await pc.refundPackageCredit(tx, bookingId, b.user_class_package_id, gymId);
    }

    // Only a freed 'booked' slot promotes someone; cancelling a 'waitlisted' or
    // 'attended' booking doesn't create a new spot.
    if (b.status !== 'booked') return { promoted: null };

    const { rows: waitRows } = await tx.query(
      `SELECT id, member_id, waitlist_position FROM bookings
       WHERE class_session_id = ? AND status = 'waitlisted'
       ORDER BY waitlist_position ASC LIMIT 1 FOR UPDATE`,
      [b.class_session_id],
    );
    if (waitRows.length === 0) return { promoted: null };
    await tx.query(
      "UPDATE bookings SET status='booked', booked_at=UTC_TIMESTAMP(), waitlist_position=NULL WHERE id = ?",
      [waitRows[0].id],
    );

    // Promoted member may now need to debit a package. Re-run the access
    // hooks against the promoted member to establish intent, then debit.
    const promotedMemberId = waitRows[0].member_id;
    const { rows: sessionRow } = await tx.query(
      'SELECT activity_type_id, center_id FROM class_sessions WHERE id = ?',
      [b.class_session_id],
    );
    for (const hook of accessHooks) {
      try { await hook(tx, gymId, promotedMemberId, sessionRow[0].activity_type_id, sessionRow[0].center_id); }
      catch { /* promotion never fails; if hook throws, the promoted member just doesn't get a package debit */ }
    }
    const pc = await packageCredits();
    await pc.debitPackageIfClaimed(tx, waitRows[0].id, gymId);

    return { promoted: waitRows[0].id };
  });
}

bookingsRouter.post('/', requireRole('admin', 'staff'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { member_id, class_session_id } = req.body;
  if (!member_id || !class_session_id) {
    return res.status(400).json({ error: 'member_id and class_session_id are required' });
  }
  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [member_id, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  try {
    const result = await bookMemberOnSession(gymId, member_id, class_session_id);
    const { rows } = await db.query(`${SELECT} WHERE b.id = ?`, [result.id]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This member already has an active booking for this session.' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

bookingsRouter.delete('/:id', requireRole('admin', 'staff'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    await cancelBooking(gymId, Number(req.params.id), gymMembershipId);
    res.status(204).send();
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** Mark attendance — staff-level. */
bookingsRouter.post('/:id/attendance', requireRole('admin', 'staff', 'coach'), async (req, res) => {
  const { gymId, userId, gymMembershipId } = getTenantContext(req);
  const { status } = req.body;
  if (!['attended', 'no_show'].includes(status)) {
    return res.status(400).json({ error: "status must be 'attended' or 'no_show'" });
  }
  const { rowCount } = await db.query(
    `UPDATE bookings SET status = ?, attendance_confirmed_at = UTC_TIMESTAMP(), attendance_confirmed_by = ?,
       modified_at = UTC_TIMESTAMP(), modified_by_membership_id = ?
     WHERE id = ? AND gym_id = ? AND status IN ('booked','attended','no_show')`,
    [status, userId, gymMembershipId, req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Booking not found or not in a bookable state' });
  const { rows } = await db.query(`${SELECT} WHERE b.id = ? AND b.gym_id = ?`, [req.params.id, gymId]);
  res.json(rows[0]);
});
