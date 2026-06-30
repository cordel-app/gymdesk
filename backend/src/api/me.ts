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
       WHERE email = $1 AND gym_id = $2 AND clerk_user_id IS NULL AND deleted_at IS NULL`,
      [email, gymId],
    );
    if (!memberRows[0]) {
      return res.status(404).json({ error: 'No pending invitation found for this email in this gym.' });
    }
    const member = memberRows[0];

    // Link the Clerk user and create membership in a transaction
    await db.query('BEGIN');
    try {
      await db.query(
        'UPDATE members SET clerk_user_id = $1 WHERE id = $2',
        [userId, member.id],
      );
      await db.query(
        `INSERT INTO gym_memberships (user_id, gym_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (user_id, gym_id) DO NOTHING`,
        [userId, gymId],
      );
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }

    res.json({ ...member, clerk_user_id: userId });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/profile', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId, userId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT m.*, f.name AS fare_name, f.price AS fare_price
       FROM members m
       LEFT JOIN fares f ON f.id = m.fare_id
       WHERE m.gym_id = $1 AND m.clerk_user_id = $2 AND m.deleted_at IS NULL`,
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
       WHERE b.gym_id = $1 AND m.clerk_user_id = $2
       ORDER BY c.starts_at ASC`,
      [gymId, userId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

meRouter.get('/subscriptions', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const { gymId, userId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      `SELECT s.*
       FROM subscriptions s
       JOIN members m ON m.id = s.member_id
       WHERE s.gym_id = $1 AND m.clerk_user_id = $2
       ORDER BY s.starts_at DESC`,
      [gymId, userId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
