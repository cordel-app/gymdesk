import { Router, Request, Response, NextFunction } from 'express';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { bookMemberOnSession, cancelBooking } from './bookings';

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

export const meRouter = Router();

// Called once on first sign-in: links Clerk user to members row and creates gym_memberships entry.
// Does NOT use tenantContext — the membership row doesn't exist yet.
export const meLinkRouter = Router();

meLinkRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).auth?.userId;
  const gymId = req.headers['x-gym-id'] as string | undefined;
  if (!gymId) return res.status(400).json({ error: 'x-gym-id header is required' });

  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    const email = clerkUser.emailAddresses[0]?.emailAddress;
    if (!email) return res.status(400).json({ error: 'No email on Clerk account' });

    // Find an unlinked member row matching this email in the gym
    const { rows: memberRows } = await db.query(
      `SELECT * FROM members
       WHERE email = ? AND gym_id = ? AND clerk_user_id IS NULL AND deleted_at IS NULL`,
      [email, gymId],
    );
    if (!memberRows[0]) {
      return res.status(404).json({ error: 'No pending invitation found for this email in this gym.' });
    }
    const member = memberRows[0];

    // Link the Clerk user and create membership in a transaction
    await db.transaction(async (tx) => {
      await tx.query(
        'UPDATE members SET clerk_user_id = ? WHERE id = ?',
        [userId, member.id],
      );
      // INSERT IGNORE = the old ON CONFLICT DO NOTHING (row may exist from a retry)
      await tx.query(
        `INSERT IGNORE INTO gym_memberships (user_id, gym_id, role) VALUES (?, ?, 'member')`,
        [userId, gymId],
      );
    });

    res.json({ ...member, clerk_user_id: userId });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/profile', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId, userId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT m.*, m.membership_plan_id AS fare_id,
              p.name AS fare_name, p.base_price AS fare_price
       FROM members m
       LEFT JOIN membership_plans p ON p.id = m.membership_plan_id
       WHERE m.gym_id = ? AND m.clerk_user_id = ? AND m.deleted_at IS NULL`,
      [gymId, userId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

meRouter.get('/bookings', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId, userId } = getTenantContext(req);
  try {
    // P2.5: joined via class_sessions + class_types (the flat classes table is gone).
    const { rows } = await db.query(
      `SELECT b.id, b.status, b.waitlist_position, b.booked_at, b.cancelled_at,
              b.class_session_id,
              cs.starts_at, cs.ends_at, cs.status AS session_status,
              ct.name AS class_name, ct.description
       FROM bookings b
       JOIN class_sessions cs ON cs.id = b.class_session_id
       JOIN class_types ct ON ct.id = cs.class_type_id
       JOIN members m ON m.id = b.member_id
       WHERE b.gym_id = ? AND m.clerk_user_id = ?
       ORDER BY cs.starts_at ASC`,
      [gymId, userId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * P2.8: upcoming schedule for the current member with per-session status:
 *   - spots_left: capacity minus current booked/attended/no_show count
 *   - my_booking_status: their own booking on this session (or null)
 *   - my_waitlist_position: their queue position if waitlisted
 *   - access_locked: true if the class type is plan-restricted AND the member
 *     doesn't hold a qualifying active membership; front-ends render this as a
 *     lock icon rather than a Book button.
 */
meRouter.get('/schedule', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId, userId } = getTenantContext(req);
  try {
    const { rows: memberRows } = await db.query(
      'SELECT id FROM members WHERE gym_id = ? AND clerk_user_id = ? AND deleted_at IS NULL',
      [gymId, userId],
    );
    if (memberRows.length === 0) return res.json([]);
    const memberId = memberRows[0].id;

    const from = (req.query.from as string) || new Date().toISOString();
    const to = req.query.to as string | undefined;
    const where: string[] = ["cs.gym_id = ?", "cs.status = 'scheduled'", "cs.starts_at >= ?"];
    const params: any[] = [gymId, from];
    if (to) { where.push('cs.starts_at <= ?'); params.push(to); }

    const { rows } = await db.query(
      `SELECT cs.id, cs.class_type_id, cs.starts_at, cs.ends_at,
              ct.name AS class_type_name, ct.description AS class_type_description,
              r.name AS room_name,
              COALESCE(cs.max_capacity_override, ct.max_capacity) AS effective_capacity,
              (
                SELECT COUNT(*) FROM bookings b
                WHERE b.class_session_id = cs.id AND b.status IN ('booked','attended','no_show')
              ) AS booked_count,
              (
                SELECT b.status FROM bookings b
                WHERE b.class_session_id = cs.id AND b.member_id = ? AND b.status <> 'cancelled'
                LIMIT 1
              ) AS my_booking_status,
              (
                SELECT b.waitlist_position FROM bookings b
                WHERE b.class_session_id = cs.id AND b.member_id = ? AND b.status = 'waitlisted'
                LIMIT 1
              ) AS my_waitlist_position,
              (
                SELECT b.id FROM bookings b
                WHERE b.class_session_id = cs.id AND b.member_id = ? AND b.status <> 'cancelled'
                LIMIT 1
              ) AS my_booking_id,
              (
                SELECT COUNT(*) FROM class_type_user_memberships ctum
                WHERE ctum.class_type_id = cs.class_type_id AND ctum.gym_id = cs.gym_id
              ) > 0 AND NOT EXISTS (
                SELECT 1 FROM user_memberships um
                JOIN class_type_user_memberships ctum
                  ON ctum.membership_plan_id = um.membership_plan_id AND ctum.gym_id = um.gym_id
                WHERE um.gym_id = cs.gym_id AND um.member_id = ? AND um.status = 'active'
                  AND ctum.class_type_id = cs.class_type_id
              ) AS access_locked
       FROM class_sessions cs
       JOIN class_types ct ON ct.id = cs.class_type_id
       LEFT JOIN rooms r ON r.id = cs.room_id
       WHERE ${where.join(' AND ')}
       ORDER BY cs.starts_at ASC`,
      [memberId, memberId, memberId, memberId, ...params],
    );
    const shaped = rows.map((r: any) => ({
      ...r,
      spots_left: Math.max(0, Number(r.effective_capacity) - Number(r.booked_count)),
      access_locked: !!Number(r.access_locked),
    }));
    res.json(shaped);
  } catch (err) { next(err); }
});

/** Book self on a session. Returns the booking with booked/waitlisted status. */
meRouter.post('/bookings', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId, userId } = getTenantContext(req);
  const { class_session_id } = req.body;
  if (!class_session_id) return res.status(400).json({ error: 'class_session_id is required' });
  try {
    const { rows: memberRows } = await db.query(
      'SELECT id FROM members WHERE gym_id = ? AND clerk_user_id = ? AND deleted_at IS NULL',
      [gymId, userId],
    );
    if (memberRows.length === 0) return res.status(404).json({ error: 'Member profile not found' });
    const result = await bookMemberOnSession(gymId, memberRows[0].id, Number(class_session_id));
    res.status(201).json(result);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'You already have a booking for this session.' });
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

/**
 * P3.4: caller's class packages with lazy status flip so the client can
 * render "expired" without duplicating the rule.
 */
meRouter.get('/class-packages', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId, userId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT ucp.id, ucp.sessions_remaining, ucp.expires_at, ucp.purchased_at, ucp.status,
              cp.name AS package_name, cp.number_of_sessions AS package_sessions, cp.price AS package_price
       FROM user_class_packages ucp
       JOIN class_packages cp ON cp.id = ucp.class_package_id
       JOIN members m ON m.id = ucp.member_id
       WHERE ucp.gym_id = ? AND m.clerk_user_id = ?
       ORDER BY ucp.purchased_at DESC`,
      [gymId, userId],
    );
    const shaped = rows.map((r: any) => {
      let status = r.status;
      if (status === 'active' && Number(r.sessions_remaining) <= 0) status = 'consumed';
      else if (status === 'active' && r.expires_at && new Date(r.expires_at) < new Date()) status = 'expired';
      return { ...r, status };
    });
    res.json(shaped);
  } catch (err) { next(err); }
});

/** Cancel own booking. Rejected once the session has already started. */
meRouter.delete('/bookings/:id', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId, userId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT b.id, cs.starts_at
       FROM bookings b
       JOIN class_sessions cs ON cs.id = b.class_session_id
       JOIN members m ON m.id = b.member_id
       WHERE b.id = ? AND b.gym_id = ? AND m.clerk_user_id = ?`,
      [req.params.id, gymId, userId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    if (new Date(rows[0].starts_at) <= new Date()) {
      return res.status(400).json({ error: 'Cannot cancel a booking after the session has started.' });
    }
    await cancelBooking(gymId, Number(req.params.id));
    res.status(204).send();
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// P1.8: current membership (single record) with plan + benefits inline. Returns
// { membership: {...} | null } — null when the member has none, so the client
// can render an empty state without treating 404 as an error.
meRouter.get('/membership', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId, userId } = getTenantContext(req);
  try {
    // Prefer active > paused > any non-cancelled > most recent by starts_at.
    const { rows: mships } = await db.query(
      `SELECT um.id, um.member_id, um.membership_plan_id,
              um.base_price, um.final_price, um.discount_reason, um.discount_expires_at,
              um.starts_at, um.ends_at, um.status, um.created_at,
              p.name AS plan_name, p.description AS plan_description, p.base_price AS plan_base_price
       FROM user_memberships um
       JOIN members m ON m.id = um.member_id
       LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
       WHERE um.gym_id = ? AND m.clerk_user_id = ?
       ORDER BY
         FIELD(um.status, 'active','paused','expired','cancelled'),
         um.starts_at DESC
       LIMIT 1`,
      [gymId, userId],
    );
    if (!mships[0]) return res.json({ membership: null });

    const um = mships[0];
    let benefits: any[] = [];
    if (um.membership_plan_id) {
      const { rows } = await db.query(
        `SELECT mpb.quantity, mpb.duration_days, mpb.recurrence,
                mpb.valid_from, mpb.valid_to, bt.code AS benefit_code
         FROM membership_plan_benefits mpb
         JOIN benefit_types bt ON bt.id = mpb.benefit_type_id
         WHERE mpb.membership_plan_id = ? AND mpb.gym_id = ?
         ORDER BY mpb.id ASC`,
        [um.membership_plan_id, gymId],
      );
      benefits = rows;
    }
    res.json({ membership: { ...um, benefits } });
  } catch (err) {
    next(err);
  }
});

// P1.8: read-only paginated ledger for the caller's own member row.
meRouter.get('/billing-events', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId, userId } = getTenantContext(req);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? 50), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  try {
    // JOIN via members.clerk_user_id — never trust client-supplied member_id.
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM billing_events be
       JOIN members m ON m.id = be.member_id
       WHERE be.gym_id = ? AND m.clerk_user_id = ?`,
      [gymId, userId],
    );
    const { rows } = await db.query(
      `SELECT be.id, be.user_membership_id, be.event_type, be.previous_status, be.new_status,
              be.amount, be.notes, be.created_at, ct.code AS charge_type_code
       FROM billing_events be
       JOIN members m ON m.id = be.member_id
       LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
       WHERE be.gym_id = ? AND m.clerk_user_id = ?
       ORDER BY be.created_at DESC, be.id DESC LIMIT ${limit} OFFSET ${offset}`,
      [gymId, userId],
    );
    res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
  } catch (err) {
    next(err);
  }
});
