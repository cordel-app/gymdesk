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
  name: string | null;
  role: 'admin' | 'coach' | 'staff';
  status: 'invited' | 'active';
  created_at: string;
}

function shapeGymUser(row: any, clerkUser: any): GymUser {
  // For invited users, clerkUser will be empty
  if (!clerkUser || !clerkUser.id) {
    return {
      id: row.id,
      user_id: row.user_id,
      email: row.email ?? null,
      name: row.name ?? null,
      role: row.role,
      status: row.status ?? 'active',
      created_at: row.created_at,
    };
  }

  const primaryEmail = clerkUser.emailAddresses?.find((e: any) => e.id === clerkUser.primaryEmailAddressId)
    ?? clerkUser.emailAddresses?.[0];
  return {
    id: row.id,
    user_id: row.user_id,
    email: primaryEmail?.emailAddress ?? null,
    name: row.name ?? null,
    role: row.role,
    status: row.status ?? 'active',
    created_at: row.created_at,
  };
}

// GET / — list all admin/coach/staff in the current gym with Clerk profile data
gymUsersRouter.get('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query<any>(
      'SELECT id, user_id, role, status, email, name, created_at FROM gym_memberships WHERE gym_id = ? AND role IN ("admin","coach","staff") ORDER BY created_at DESC',
      [gymId],
    );

    // Separate invited users from active users
    const activeRows = rows.filter((r) => r.status === 'active' && !r.user_id.startsWith('invited_'));
    const invitedRows = rows.filter((r) => r.status === 'invited');

    // Batch-fetch Clerk users only for active users
    let clerkUsers: any[] = [];
    if (activeRows.length > 0) {
      const userIds = activeRows.map((r) => r.user_id);
      const { data } = await clerkClient.users.getUserList({ userId: userIds });
      clerkUsers = data;
    }
    const clerkMap = Object.fromEntries(clerkUsers.map((u) => [u.id, u]));

    // Shape all users
    const shaped = [
      ...activeRows.map((row) => shapeGymUser(row, clerkMap[row.user_id] ?? {})),
      ...invitedRows.map((row) => shapeGymUser(row, {})), // Invited users have no Clerk data
    ];

    res.json(shaped);
  } catch (err) { next(err); }
});

// POST / — invite or grant a user (existing Clerk user or new invitation)
gymUsersRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const role = String(req.body?.role ?? '').trim();
  const name = String(req.body?.name ?? '').trim() || null;

  if (!email) return res.status(400).json({ error: 'email is required' });
  if (!['admin', 'coach', 'staff'].includes(role)) {
    return res.status(400).json({ error: 'role must be one of: admin, coach, staff' });
  }

  try {
    // Look up existing Clerk user
    let existing;
    try {
      const { data: matches } = await clerkClient.users.getUserList({ emailAddress: [email], limit: 1 });
      existing = matches[0];
    } catch (err: any) {
      console.error('Clerk getUserList error:', { message: err.message, status: err.status, errors: err.errors });
      // Provide more specific error message based on Clerk error
      if (err.status === 401) {
        return res.status(500).json({ error: 'Clerk authentication failed. Check CLERK_SECRET_KEY.' });
      }
      if (err.message?.includes('rate_limited')) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }
      return res.status(500).json({ error: 'Failed to lookup user: ' + (err.message || 'Unknown Clerk error') });
    }

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

    // Check if already invited to this gym (with 'invited' status)
    const { rows: invitedRows } = await db.query<any>(
      'SELECT id FROM gym_memberships WHERE email = ? AND gym_id = ? AND status = ?',
      [email, gymId, 'invited'],
    );
    if (invitedRows.length > 0) {
      return res.status(409).json({ error: `${email} has already been invited to this gym. They can accept the invitation to join.` });
    }

    // No Clerk user yet — send an invitation with gym_invite metadata
    const adminUrl = process.env.CORDEL_FITNESS_ADMIN_URL ?? '';
    console.log('Creating Clerk invitation:', { email, adminUrl, gym_id: gymId, role });

    let clerkInvitation: any = null;
    try {
      // Step 1: Create Clerk invitation FIRST
      clerkInvitation = await clerkClient.invitations.createInvitation({
        emailAddress: email,
        publicMetadata: { gym_invite: { gym_id: gymId, role } },
        ...(adminUrl ? { redirectUrl: `${adminUrl}/en/sign-up` } : {}),
      });
      console.log('Clerk invitation created successfully for:', email);

      // Step 2: Only after Clerk succeeds, create database record
      // This ensures we don't create a DB record for an invitation that doesn't exist in Clerk
      const tempUserId = `invited_${Date.now()}`;
      const { insertId } = await db.query(
        'INSERT INTO gym_memberships (user_id, gym_id, role, status, email, name, invitation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [tempUserId, gymId, role, 'invited', email, name, clerkInvitation.id],
      );

      recordAudit(req, { action: 'invite', entityType: 'gym_user', entityId: email, next: { email, role } });
      return res.status(201).json({ status: 'invited', email });
    } catch (err: any) {
      // If Clerk invitation succeeded but DB insert failed, we have an inconsistency
      if (clerkInvitation && err.message?.includes('INSERT')) {
        console.error('Database insert failed after Clerk invitation created. Clerk invitation exists but DB record failed:', { email, error: err.message });
        return res.status(500).json({ error: 'Failed to save invitation to database. Please contact support.' });
      }
      const errorDetails = { message: err.message, status: err.status, errors: err.errors, clerkErrors: err.clerkErrors };
      console.error('Clerk invitations.createInvitation error:', errorDetails);

      // 422 Unprocessable Entity - duplicate pending invitations
      if (err.status === 422) {
        recordAudit(req, { action: 'invite', entityType: 'gym_user', entityId: email, next: { email, role } });
        return res.status(201).json({ status: 'invited', email, note: 'Invitation already sent' });
      }
      // 400 Bad Request - often means invitation already exists
      if (err.status === 400) {
        const errorMsg = err.errors?.[0]?.message || err.message || '';
        if (errorMsg.includes('existing') || errorMsg.includes('already') || errorMsg.includes('pending') || errorMsg.includes('duplicate')) {
          // Invitation already pending - return success with resent message
          recordAudit(req, { action: 'invite', entityType: 'gym_user', entityId: email, next: { email, role } });
          return res.status(201).json({ status: 'invited', email, note: 'Invitation already sent' });
        }
        return res.status(400).json({ error: 'Invalid request: ' + errorMsg });
      }
      if (err.status === 401) {
        return res.status(500).json({ error: 'Clerk authentication failed. Check CLERK_SECRET_KEY.' });
      }
      if (err.status === 429) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
      }
      if (err.message?.includes('invalid_email')) {
        return res.status(400).json({ error: 'Invalid email address format.' });
      }
      return res.status(500).json({ error: 'Failed to send invitation: ' + (err.message || 'Unknown error') });
    }
  } catch (err: any) {
    console.error('Unexpected error in POST /gym-users:', { message: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error: ' + (err.message || 'Unknown error') });
  }
});

// PATCH /:id — change role/name of an existing gym_user
gymUsersRouter.patch('/:id', requireRole('admin'), async (req, res, next) => {
  const { userId: callerUserId, gymId } = getTenantContext(req);
  const membershipId = Number(req.params.id);
  const role = String(req.body?.role ?? '').trim();
  const name = req.body?.name ? String(req.body.name).trim() : undefined;

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

    // Update role and/or name
    const updates = ['role = ?'];
    const values: any[] = [role];
    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name || null);
    }
    values.push(membershipId);

    await db.query(
      `UPDATE gym_memberships SET ${updates.join(', ')} WHERE id = ?`,
      values,
    );
    recordAudit(req, { action: 'change_role', entityType: 'gym_user', entityId: String(membershipId), previous: { role: membership.role }, next: { role } });

    // Return updated row with Clerk data
    const { rows: updated } = await db.query<any>(
      'SELECT * FROM gym_memberships WHERE id = ?',
      [membershipId],
    );
    const clerkUser = await clerkClient.users.getUser(updated[0].user_id);
    res.json(shapeGymUser(updated[0], clerkUser));
  } catch (err) { next(err); }
});

// POST /:id/reinvite — resend invitation email for invited (not yet accepted) users
gymUsersRouter.post('/:id/reinvite', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const membershipId = Number(req.params.id);

  try {
    // Fetch the target membership
    const { rows } = await db.query<any>(
      'SELECT * FROM gym_memberships WHERE id = ? AND gym_id = ?',
      [membershipId, gymId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });

    const membership = rows[0];

    // Only allow reinviting users with status='invited'
    if (membership.status !== 'invited') {
      return res.status(400).json({ error: 'Can only reinvite users who are pending invitation. This user has already accepted.' });
    }

    const email = membership.email;
    const adminUrl = process.env.CORDEL_FITNESS_ADMIN_URL ?? '';

    try {
      // Create new Clerk invitation
      await clerkClient.invitations.createInvitation({
        emailAddress: email,
        publicMetadata: { gym_invite: { gym_id: gymId, role: membership.role } },
        ...(adminUrl ? { redirectUrl: `${adminUrl}/en/sign-up` } : {}),
      });

      recordAudit(req, { action: 'reinvite', entityType: 'gym_user', entityId: String(membershipId), next: { email } });
      return res.json({ status: 'reinvited', email });
    } catch (err: any) {
      const errorMsg = err.errors?.[0]?.message || err.message || '';
      console.error('Clerk invitation error on reinvite:', { message: err.message, status: err.status, email });

      if (err.status === 422 || errorMsg.includes('duplicate') || errorMsg.includes('pending')) {
        return res.status(409).json({ error: 'An invitation is already pending for this email.' });
      }
      if (err.status === 400) {
        return res.status(400).json({ error: 'Invalid request: ' + errorMsg });
      }
      if (err.status === 401) {
        return res.status(500).json({ error: 'Clerk authentication failed.' });
      }
      return res.status(500).json({ error: 'Failed to send invitation: ' + (err.message || 'Unknown error') });
    }
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

    // If user is invited, revoke the Clerk invitation
    if (membership.status === 'invited' && membership.invitation_id) {
      try {
        await clerkClient.invitations.revokeInvitation(membership.invitation_id);
        console.log('Revoked Clerk invitation:', membership.invitation_id);
      } catch (err: any) {
        console.error('Failed to revoke Clerk invitation:', { invitationId: membership.invitation_id, error: err.message });
        // Continue with deletion even if revoke fails
      }
    }

    // If this is their last gym membership anywhere, delete the Clerk account too.
    // Clerk delete must succeed before we touch our own data — if it fails, abort
    // and leave the membership row in place rather than orphaning the Clerk user.
    if (membership.status !== 'invited' && !String(membership.user_id).startsWith('invited_')) {
      const { rows: otherMemberships } = await db.query<any>(
        'SELECT COUNT(*) as cnt FROM gym_memberships WHERE user_id = ? AND gym_id != ?',
        [membership.user_id, gymId],
      );
      if (otherMemberships[0].cnt === 0) {
        try {
          await clerkClient.users.deleteUser(membership.user_id);
          console.log('Deleted Clerk user:', membership.user_id);
        } catch (err: any) {
          console.error('Failed to delete Clerk user:', { userId: membership.user_id, error: err.message });
          return res.status(502).json({ error: 'Failed to delete user from Clerk. Team member was not removed.' });
        }
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

/**
 * Materialize a gym_memberships row from a user's Clerk `gym_invite` metadata.
 * Shared by the admin-app self-heal (POST /link) and the Clerk `user.created`
 * webhook, so activation happens whichever path fires first. Idempotent: once
 * the metadata is cleared, subsequent calls return { linked: false }.
 *
 * @returns the materialized row, or null when there is no pending invite.
 */
export async function linkGymInvite(userId: string): Promise<any | null> {
  const clerkUser = await clerkClient.users.getUser(userId);
  const meta = (clerkUser.publicMetadata as any) ?? {};
  const gymInvite = meta.gym_invite;

  if (!gymInvite) return null;

  const { gym_id: gymId, role } = gymInvite;

  // Get the user's email to match against invited row (case-insensitive: the
  // placeholder row stored the email lowercased at invite time).
  const userEmail = clerkUser.emailAddresses?.[0]?.emailAddress ?? (clerkUser as any).email;

  // Check if there's an invited placeholder row and update it, or insert new row
  const { rows: existingInvited } = await db.query<any>(
    'SELECT id FROM gym_memberships WHERE gym_id = ? AND role = ? AND status = ? AND LOWER(email) = LOWER(?)',
    [gymId, role, 'invited', userEmail],
  );

  if (existingInvited.length > 0) {
    // Update the placeholder invited row to active with the real user_id
    await db.query(
      'UPDATE gym_memberships SET user_id = ?, status = ?, email = NULL WHERE id = ?',
      [userId, 'active', existingInvited[0].id],
    );
  } else {
    // Insert new row as active (for direct grants)
    await db.query(
      'INSERT IGNORE INTO gym_memberships (user_id, gym_id, role, status) VALUES (?, ?, ?, ?)',
      [userId, gymId, role, 'active'],
    );
  }

  // Fetch the inserted/existing row
  const { rows } = await db.query<any>(
    'SELECT * FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
    [userId, gymId],
  );

  // Clear the gym_invite metadata so this only materializes once
  await clerkClient.users.updateUserMetadata(userId, {
    publicMetadata: { ...meta, gym_invite: null },
  });

  recordAudit(
    { tenantCtx: { userId, gymId, role: 'admin' } } as any,
    { action: 'link', entityType: 'gym_user', entityId: userId, next: { gym_id: gymId, role } },
  );

  return rows[0];
}

// POST /link — called by admin app on first sign-in; materializes gym_memberships from Clerk metadata
gymUsersLinkRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const row = await linkGymInvite(userId);
    if (!row) return res.status(404).json({ error: 'No pending team invitation found.' });
    res.json(row);
  } catch (err) { next(err); }
});
