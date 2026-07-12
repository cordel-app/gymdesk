import { Router, Request, Response, NextFunction } from 'express';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

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
    const { rows } = await db.query(
      `SELECT b.*, c.name AS class_name, c.starts_at, c.ends_at, c.description
       FROM bookings b
       JOIN classes c ON c.id = b.class_id
       JOIN members m ON m.id = b.member_id
       WHERE b.gym_id = ? AND m.clerk_user_id = ?
       ORDER BY c.starts_at ASC`,
      [gymId, userId],
    );
    res.json(rows);
  } catch (err) {
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
