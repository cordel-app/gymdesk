import { Router, Request, Response, NextFunction } from 'express';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

/**
 * #53: Gym-scoped team management. Admins invite/grant/change-role/remove
 * coaches and staff within their gym. Mirrors superadmins.ts but for
 * gym_memberships rows (roles: admin/coach/staff) instead of platform roles.
 *
 * Invitation flow:
 *   - Grant by email of a user Clerk knows → INSERT INTO gym_memberships.
 *   - Grant by email Clerk doesn't know → Clerk invitation with gym_invite metadata.
 *   - On invitee's first admin-app sign-in → POST /link materializes row + clears metadata.
 *
 * Guards:
 *   - Self-edit blocked (can't change your own role or remove yourself).
 *   - Last-admin protection (can't demote/remove the sole remaining admin).
 */
export const gymUsersRouter = Router();
export const gymUsersLinkRouter = Router();

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

interface GymUser {
  id: number;
  user_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  role: 'admin' | 'coach' | 'staff';
  created_at: string;
}

function shapeGymUser(row: any, clerkUser: any): GymUser {
  const primaryEmail = clerkUser.emailAddresses?.find((e: any) => e.id === clerkUser.primaryEmailAddressId)
    ?? clerkUser.emailAddresses?.[0];
  return {
    id: row.id,
    user_id: row.user_id,
    email: primaryEmail?.emailAddress ?? null,
    first_name: clerkUser.firstName ?? null,
    last_name: clerkUser.lastName ?? null,
    role: row.role,
    created_at: row.created_at,
  };
}

// GET / — list all admin/coach/staff in the current gym with Clerk profile data
gymUsersRouter.get('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query<any>(
      'SELECT id, user_id, role, created_at FROM gym_memberships WHERE gym_id = ? AND role IN ("admin","coach","staff") ORDER BY created_at DESC',
      [gymId],
    );

    // Batch-fetch Clerk users by user_id
    const userIds = rows.map((r) => r.user_id);
    let clerkUsers: any[] = [];
    if (userIds.length > 0) {
      const { data } = await clerkClient.users.getUserList({ userId: userIds });
      clerkUsers = data;
    }
    const clerkMap = Object.fromEntries(clerkUsers.map((u) => [u.id, u]));

    const shaped = rows.map((row) => shapeGymUser(row, clerkMap[row.user_id] ?? {}));
    res.json(shaped);
  } catch (err) { next(err); }
});

// POST / — invite or grant a user (existing Clerk user or new invitation)
gymUsersRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const role = String(req.body?.role ?? '').trim();

  if (!email) return res.status(400).json({ error: 'email is required' });
  if (!['admin', 'coach', 'staff'].includes(role)) {
    return res.status(400).json({ error: 'role must be one of: admin, coach, staff' });
  }

  try {
    // Look up existing Clerk user
    const { data: matches } = await clerkClient.users.getUserList({ emailAddress: [email], limit: 1 });
    const existing = matches[0];

    if (existing) {
      // User exists in Clerk — insert or update gym_memberships
      const { rows: existing_rows } = await db.query<any>(
        'SELECT * FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
        [existing.id, gymId],
      );
      const existing_row = existing_rows[0];

      if (existing_row && existing_row.role === role) {
        // Already has this role — idempotent no-op
        return res.status(200).json({ status: 'already_granted', membership: shapeGymUser(existing_row, existing) });
      }

      // Insert or update
      if (existing_row) {
        // Update existing row
        await db.query(
          'UPDATE gym_memberships SET role = ? WHERE id = ?',
          [role, existing_row.id],
        );
        recordAudit(req, { action: 'change_role', entityType: 'gym_user', entityId: String(existing_row.id), previous: { role: existing_row.role }, next: { role } });
      } else {
        // Insert new row
        const { insertId } = await db.query(
          'INSERT INTO gym_memberships (user_id, gym_id, role) VALUES (?, ?, ?)',
          [existing.id, gymId, role],
        );
        recordAudit(req, { action: 'grant', entityType: 'gym_user', entityId: String(insertId), next: { email, role } });
      }

      const { rows: updated } = await db.query<any>(
        'SELECT * FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
        [existing.id, gymId],
      );
      return res.status(201).json({ status: 'granted', membership: shapeGymUser(updated[0], existing) });
    }

    // No Clerk user yet — send an invitation with gym_invite metadata
    const adminUrl = process.env.CORDEL_FITNESS_ADMIN_URL ?? '';
    try {
      await clerkClient.invitations.createInvitation({
        emailAddress: email,
        publicMetadata: { gym_invite: { gym_id: gymId, role } },
        ...(adminUrl ? { redirectUrl: `${adminUrl}/en/link-team` } : {}),
      });
      recordAudit(req, { action: 'invite', entityType: 'gym_user', entityId: email, next: { email, role } });
      return res.status(201).json({ status: 'invited', email });
    } catch (err: any) {
      // Clerk returns 422 for duplicate pending invitations
      if (err.status === 422) {
        return res.status(409).json({ error: 'An invitation is already pending for this email.' });
      }
      throw err;
    }
  } catch (err) { next(err); }
});

// PATCH /:id — change role of an existing gym_user
gymUsersRouter.patch('/:id', requireRole('admin'), async (req, res, next) => {
  const { userId: callerUserId, gymId } = getTenantContext(req);
  const membershipId = Number(req.params.id);
  const role = String(req.body?.role ?? '').trim();

  if (!['admin', 'coach', 'staff'].includes(role)) {
    return res.status(400).json({ error: 'role must be one of: admin, coach, staff' });
  }

  try {
    // Fetch the target membership
    const { rows } = await db.query<any>(
      'SELECT * FROM gym_memberships WHERE id = ? AND gym_id = ?',
      [membershipId, gymId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });

    const membership = rows[0];

    // Self-guard
    if (membership.user_id === callerUserId) {
      return res.status(400).json({ error: 'Cannot change your own role — ask a peer admin.' });
    }

    // Last-admin protection: if target is currently admin and being demoted, check admin count
    if (membership.role === 'admin' && role !== 'admin') {
      const { rows: adminCount } = await db.query<any>(
        'SELECT COUNT(*) as cnt FROM gym_memberships WHERE gym_id = ? AND role = ?',
        [gymId, 'admin'],
      );
      if (adminCount[0].cnt === 1) {
        return res.status(400).json({ error: 'Cannot demote the last admin in this gym.' });
      }
    }

    // Update role
    await db.query(
      'UPDATE gym_memberships SET role = ? WHERE id = ?',
      [role, membershipId],
    );
    recordAudit(req, { action: 'change_role', entityType: 'gym_user', entityId: String(membershipId), previous: { role: membership.role }, next: { role } });

    // Return updated row
    const { rows: updated } = await db.query<any>(
      'SELECT * FROM gym_memberships WHERE id = ?',
      [membershipId],
    );
    res.json(updated[0]);
  } catch (err) { next(err); }
});

// DELETE /:id — remove a gym_user
gymUsersRouter.delete('/:id', requireRole('admin'), async (req, res, next) => {
  const { userId: callerUserId, gymId } = getTenantContext(req);
  const membershipId = Number(req.params.id);

  try {
    // Fetch the target membership
    const { rows } = await db.query<any>(
      'SELECT * FROM gym_memberships WHERE id = ? AND gym_id = ?',
      [membershipId, gymId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });

    const membership = rows[0];

    // Self-guard
    if (membership.user_id === callerUserId) {
      return res.status(400).json({ error: 'Cannot remove yourself — ask a peer admin.' });
    }

    // Last-admin protection
    if (membership.role === 'admin') {
      const { rows: adminCount } = await db.query<any>(
        'SELECT COUNT(*) as cnt FROM gym_memberships WHERE gym_id = ? AND role = ?',
        [gymId, 'admin'],
      );
      if (adminCount[0].cnt === 1) {
        return res.status(400).json({ error: 'Cannot remove the last admin in this gym.' });
      }
    }

    // Delete
    await db.query(
      'DELETE FROM gym_memberships WHERE id = ?',
      [membershipId],
    );
    recordAudit(req, { action: 'remove', entityType: 'gym_user', entityId: String(membershipId), previous: { role: membership.role } });
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /link — called by admin app on first sign-in; materializes gym_memberships from Clerk metadata
gymUsersLinkRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    const meta = (clerkUser.publicMetadata as any) ?? {};
    const gymInvite = meta.gym_invite;

    if (!gymInvite) {
      return res.status(404).json({ error: 'No pending team invitation found.' });
    }

    const { gym_id: gymId, role } = gymInvite;

    // Insert the membership (INSERT IGNORE for idempotent retries)
    await db.query(
      'INSERT IGNORE INTO gym_memberships (user_id, gym_id, role) VALUES (?, ?, ?)',
      [userId, gymId, role],
    );

    // Fetch the inserted/existing row
    const { rows } = await db.query<any>(
      'SELECT * FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
      [userId, gymId],
    );

    // Clear the gym_invite metadata
    await clerkClient.users.updateUserMetadata(userId, {
      publicMetadata: { ...meta, gym_invite: null },
    });

    recordAudit(
      { tenantCtx: { userId, gymId, role: 'admin' } } as any,
      { action: 'link', entityType: 'gym_user', entityId: userId, next: { gym_id: gymId, role } },
    );

    res.json(rows[0]);
  } catch (err) { next(err); }
});
