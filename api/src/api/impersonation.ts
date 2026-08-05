import { Router } from 'express';
import { createClerkClient } from '@clerk/backend';
import { requireSuperadmin } from '../infra/tenantContext';
import { db } from '../infra/db';

export const impersonationRouter = Router();

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

/**
 * GET /platform/impersonation/candidates?q=<search>&gym_id=<id>
 * Superadmin-only. Returns active members + staff for the given gym, excluding
 * the caller and other superadmins. Used by the Impersonate dialog.
 */
impersonationRouter.get('/candidates', requireSuperadmin, async (req, res, next) => {
  const adminId = req.auth!.userId;
  const gymId = req.query.gym_id as string | undefined;
  const q = ((req.query.q as string) ?? '').trim();

  console.log('[Impersonation] Candidates search request', { adminId, gymId, q });

  if (!gymId) return res.status(400).json({ error: 'gym_id query param required' });

  try {
    const like = `%${q}%`;

    // Staff: active gym_memberships rows with non-member roles
    const { rows: staffRows } = await db.query<{
      user_id: string; name: string; role: string; gym_id: string;
    }>(
      `SELECT gm.user_id, gm.name, gm.role, gm.gym_id
       FROM gym_memberships gm
       WHERE gm.gym_id = ?
         AND gm.user_id != ?
         AND gm.status = 'active'
         AND gm.role != 'member'
         AND gm.name LIKE ?
       ORDER BY gm.name ASC
       LIMIT 50`,
      [gymId, adminId, like],
    );

    // Members: members table rows that are linked (have a clerk_user_id) and not deleted
    const { rows: memberRows } = await db.query<{
      user_id: string; name: string; gym_id: string;
    }>(
      `SELECT m.clerk_user_id AS user_id, m.name, m.gym_id
       FROM members m
       WHERE m.gym_id = ?
         AND m.clerk_user_id != ?
         AND m.clerk_user_id IS NOT NULL
         AND m.deleted_at IS NULL
         AND m.name LIKE ?
       ORDER BY m.name ASC
       LIMIT 50`,
      [gymId, adminId, like],
    );

    // Filter out other superadmins from staff list
    const staffFiltered: any[] = [];
    for (const s of staffRows) {
      try {
        const u = await clerkClient.users.getUser(s.user_id);
        if ((u.publicMetadata as any)?.platform_role === 'superadmin') continue;
        staffFiltered.push({ userId: s.user_id, name: s.name, type: 'staff', role: s.role, gymId: s.gym_id });
      } catch { /* skip users that no longer exist in Clerk */ }
    }

    const members = memberRows.map((m) => ({
      userId: m.user_id,
      name: m.name,
      type: 'member',
      role: 'member',
      gymId: m.gym_id,
    }));

    // Deduplicate: a user could appear in both lists if a staff member also has a members row
    const seen = new Set<string>(staffFiltered.map((s) => s.userId));
    const dedupedMembers = members.filter((m) => !seen.has(m.userId));

    const results = [...staffFiltered, ...dedupedMembers];
    console.log('[Impersonation] Candidates search response', { gymId, q, count: results.length });
    res.json(results);
  } catch (err) { next(err); }
});

/**
 * POST /platform/impersonation/stop
 * Superadmin-only. Signals the end of an impersonation session.
 * Declared BEFORE /:userId so it isn't swallowed by the dynamic segment.
 */
impersonationRouter.post('/stop', requireSuperadmin, async (req, res, next) => {
  const { impersonated_user_id, impersonated_user_name, impersonated_role, duration_seconds } = req.body ?? {};

  if (!impersonated_user_id) return res.status(400).json({ error: 'impersonated_user_id required' });

  try {
    void { impersonated_user_name, impersonated_role, duration_seconds }; // accepted but not stored (no tenantCtx on platform routes)
    res.status(204).send();
  } catch (err) { next(err); }
});

/**
 * POST /platform/impersonation/:userId
 * Superadmin-only. Validates the target, then returns
 * the effective user's data for the frontend banner and role override.
 */
impersonationRouter.post('/:userId', requireSuperadmin, async (req, res, next) => {
  const adminId = req.auth!.userId;
  const targetId = String(req.params.userId);
  const gymId = req.headers['x-gym-id'] as string | undefined;

  if (!gymId) return res.status(400).json({ error: 'x-gym-id header required' });
  if (targetId === adminId) return res.status(400).json({ error: 'Cannot impersonate yourself' });

  try {
    const targetUser = await clerkClient.users.getUser(targetId).catch(() => null);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if ((targetUser.publicMetadata as any)?.platform_role === 'superadmin') {
      return res.status(400).json({ error: 'Cannot impersonate another superadmin' });
    }

    // Validate active membership (status='active', not soft-deleted)
    const { rows } = await db.query<{ id: number; role: string }>(
      `SELECT gm.id, gm.role FROM gym_memberships gm
       WHERE gm.user_id = ? AND gm.gym_id = ?
         AND gm.status = 'active'`,
      [targetId, gymId],
    );

    if (!rows[0]) {
      // Also allow members who have a members row (linked, not deleted) — member role
      const { rows: memberRows } = await db.query<{ id: number }>(
        `SELECT gm.id FROM gym_memberships gm
         JOIN members m ON m.clerk_user_id = gm.user_id AND m.gym_id = gm.gym_id
         WHERE gm.user_id = ? AND gm.gym_id = ?
           AND gm.role = 'member'
           AND m.deleted_at IS NULL`,
        [targetId, gymId],
      );
      if (!memberRows[0]) {
        return res.status(400).json({ error: 'Target user has no active membership in this gym' });
      }
    }

    const primaryEmail = targetUser.emailAddresses?.find(
      (e: any) => e.id === targetUser.primaryEmailAddressId,
    ) ?? targetUser.emailAddresses?.[0];

    const targetName =
      targetUser.fullName ||
      [targetUser.firstName, targetUser.lastName].filter(Boolean).join(' ') ||
      primaryEmail?.emailAddress ||
      targetId;

    // Fetch all gym IDs the target belongs to (for gym selector restriction)
    const { rows: gymRows } = await db.query<{ gym_id: string }>(
      `SELECT gym_id FROM gym_memberships WHERE user_id = ? AND status = 'active'`,
      [targetId],
    );
    const gymIds = gymRows.map((r) => r.gym_id);

    res.json({
      id: targetId,
      name: targetName,
      role: rows[0]?.role ?? 'member',
      gym_id: gymId,
      gymIds,
    });
  } catch (err) { next(err); }
});
