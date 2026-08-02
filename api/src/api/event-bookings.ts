import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { handleDupEntry } from '../infra/db-helpers';

const SELECT = `
  SELECT eb.*, m.name AS member_name, m.email AS member_email,
         e.starts_at AS event_starts_at, e.ends_at AS event_ends_at,
         e.name AS event_name, e.capacity AS event_capacity,
         e.status AS event_status
  FROM event_bookings eb
  JOIN members m ON m.id = eb.member_id
  JOIN events e ON e.id = eb.event_id
`;

/** Book a member on a calendar event. Exported for use by /me routes. */
export async function bookMemberOnEvent(gymId: string, memberId: number, eventId: number) {
  return db.transaction(async (tx: Tx) => {
    const { rows: evRows } = await tx.query(
      `SELECT id, capacity, status, center_id
       FROM events WHERE id = ? AND gym_id = ? AND deleted_at IS NULL FOR UPDATE`,
      [eventId, gymId],
    );
    if (evRows.length === 0) throw Object.assign(new Error('Event not found'), { status: 404 });
    if (evRows[0].status !== 'scheduled') {
      throw Object.assign(new Error('Event is not open for bookings'), { status: 400 });
    }

    // Reject duplicate non-cancelled booking for same (event, member)
    const { rows: existing } = await tx.query(
      "SELECT id FROM event_bookings WHERE event_id = ? AND member_id = ? AND status <> 'cancelled'",
      [eventId, memberId],
    );
    if (existing.length > 0) {
      throw Object.assign(new Error('Member already has an active booking for this event'), { status: 409 });
    }

    const cap = evRows[0].capacity;
    const centerId = evRows[0].center_id;

    if (cap !== null) {
      const { rows: countRows } = await tx.query(
        "SELECT COUNT(*) AS booked FROM event_bookings WHERE event_id = ? AND status = 'booked'",
        [eventId],
      );
      if (Number(countRows[0].booked) < Number(cap)) {
        const { insertId } = await tx.query(
          `INSERT INTO event_bookings (gym_id, center_id, event_id, member_id, status, booked_at)
           VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`,
          [gymId, centerId, eventId, memberId],
        );
        return { id: insertId, status: 'booked', waitlist_position: null };
      }
    } else {
      // No capacity limit — always book
      const { insertId } = await tx.query(
        `INSERT INTO event_bookings (gym_id, center_id, event_id, member_id, status, booked_at)
         VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`,
        [gymId, centerId, eventId, memberId],
      );
      return { id: insertId, status: 'booked', waitlist_position: null };
    }

    // Event is at capacity — waitlist
    const { rows: nextRows } = await tx.query(
      "SELECT COALESCE(MAX(waitlist_position), 0) + 1 AS next FROM event_bookings WHERE event_id = ? AND status = 'waitlisted'",
      [eventId],
    );
    const position = Number(nextRows[0].next);
    const { insertId } = await tx.query(
      `INSERT INTO event_bookings (gym_id, center_id, event_id, member_id, status, waitlist_position, waitlisted_at)
       VALUES (?, ?, ?, ?, 'waitlisted', ?, UTC_TIMESTAMP())`,
      [gymId, centerId, eventId, memberId, position],
    );
    return { id: insertId, status: 'waitlisted', waitlist_position: position };
  });
}

/** Cancel a booking and auto-promote the next waitlisted member. Exported for /me routes. */
export async function cancelEventBooking(gymId: string, bookingId: number, actorMembershipId?: number | null) {
  return db.transaction(async (tx: Tx) => {
    const { rows: bookingRows } = await tx.query(
      'SELECT id, member_id, event_id, status FROM event_bookings WHERE id = ? AND gym_id = ? FOR UPDATE',
      [bookingId, gymId],
    );
    if (bookingRows.length === 0) throw Object.assign(new Error('Booking not found'), { status: 404 });
    const b = bookingRows[0];
    if (b.status === 'cancelled') throw Object.assign(new Error('Already cancelled'), { status: 400 });

    await tx.query(
      `UPDATE event_bookings
       SET status='cancelled', cancelled_at=UTC_TIMESTAMP(),
           modified_at=UTC_TIMESTAMP(), modified_by_membership_id=?
       WHERE id = ?`,
      [actorMembershipId ?? null, bookingId],
    );

    if (b.status !== 'booked') return { promoted: null, promotedMemberId: null };

    const { rows: waitRows } = await tx.query(
      `SELECT id, member_id FROM event_bookings
       WHERE event_id = ? AND status = 'waitlisted'
       ORDER BY waitlist_position ASC LIMIT 1 FOR UPDATE`,
      [b.event_id],
    );
    if (waitRows.length === 0) return { promoted: null, promotedMemberId: null };

    await tx.query(
      `UPDATE event_bookings
       SET status='booked', booked_at=UTC_TIMESTAMP(), waitlist_position=NULL,
           modified_at=UTC_TIMESTAMP(), modified_by_membership_id=?
       WHERE id = ?`,
      [actorMembershipId ?? null, waitRows[0].id],
    );
    return { promoted: waitRows[0].id, promotedMemberId: waitRows[0].member_id };
  });
}

export const eventBookingsRouter = Router();

eventBookingsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { event_id, status } = req.query as Record<string, string | undefined>;
  const where: string[] = ['eb.gym_id = ?'];
  const params: (string | number)[] = [gymId];
  if (event_id) { where.push('eb.event_id = ?'); params.push(event_id); }
  if (status)   { where.push('eb.status = ?'); params.push(status); }
  const { rows } = await db.query(
    `${SELECT}
     WHERE ${where.join(' AND ')}
     ORDER BY
       FIELD(eb.status, 'booked','waitlisted','cancelled'),
       eb.waitlist_position IS NULL, eb.waitlist_position ASC,
       eb.booked_at ASC`,
    params,
  );
  res.json(rows);
});

eventBookingsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `${SELECT} WHERE eb.id = ? AND eb.gym_id = ?`,
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
  res.json(rows[0]);
});

eventBookingsRouter.post('/', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { event_id, member_id } = req.body;
  if (!event_id || !member_id) {
    return res.status(400).json({ error: 'event_id and member_id are required' });
  }
  const { rows: memberRows } = await db.query(
    'SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [member_id, gymId],
  );
  if (memberRows.length === 0) return res.status(404).json({ error: 'Member not found' });

  try {
    const result = await bookMemberOnEvent(gymId, member_id, event_id);
    const { rows } = await db.query(`${SELECT} WHERE eb.id = ?`, [result.id]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    handleDupEntry(err, res, next, 'Member already has an active booking for this event.');
  }
});

eventBookingsRouter.delete('/:id', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    await cancelEventBooking(gymId, Number(req.params.id), gymMembershipId);
    res.status(204).send();
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** Manual promote — staff can move a waitlisted member to booked if capacity allows. */
eventBookingsRouter.post('/:id/promote', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  try {
    await db.transaction(async (tx: Tx) => {
      const { rows: bookingRows } = await tx.query(
        `SELECT eb.id, eb.event_id, eb.status
         FROM event_bookings eb WHERE eb.id = ? AND eb.gym_id = ? FOR UPDATE`,
        [req.params.id, gymId],
      );
      if (bookingRows.length === 0) throw Object.assign(new Error('Booking not found'), { status: 404 });
      if (bookingRows[0].status !== 'waitlisted') {
        throw Object.assign(new Error('Booking is not waitlisted'), { status: 400 });
      }
      const eventId = bookingRows[0].event_id;
      const { rows: evRows } = await tx.query(
        'SELECT capacity FROM events WHERE id = ? AND gym_id = ? FOR UPDATE',
        [eventId, gymId],
      );
      if (evRows.length === 0) throw Object.assign(new Error('Event not found'), { status: 404 });
      const cap = evRows[0].capacity;
      if (cap !== null) {
        const { rows: countRows } = await tx.query(
          "SELECT COUNT(*) AS booked FROM event_bookings WHERE event_id = ? AND status = 'booked'",
          [eventId],
        );
        if (Number(countRows[0].booked) >= Number(cap)) {
          throw Object.assign(new Error('Event is at full capacity'), { status: 409 });
        }
      }
      await tx.query(
        `UPDATE event_bookings
         SET status='booked', booked_at=UTC_TIMESTAMP(), waitlist_position=NULL,
             modified_at=UTC_TIMESTAMP(), modified_by_membership_id=?
         WHERE id = ?`,
        [gymMembershipId ?? null, req.params.id],
      );
    });
    const { rows } = await db.query(`${SELECT} WHERE eb.id = ? AND eb.gym_id = ?`, [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
