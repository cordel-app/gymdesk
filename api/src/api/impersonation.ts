import { Router } from 'express';
import { createClerkClient } from '@clerk/backend';
import { requireSuperadmin } from '../infra/tenantContext';
import { db } from '../infra/db';

export const impersonationRouter = Router();

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

/**
 * GET /platform/impersonation/targets?q=<search>&gym_id=<id>
 * Superadmin-only. Returns active members + staff for the given gym, excluding
 * the caller and other superadmins. Used by the Impersonate dialog.
 * Members are eligible regardless of whether they have a Clerk account.
 */
impersonationRouter.get('/targets', requireSuperadmin, async (req, res, next) => {
  const adminId = req.auth!.userId;
  const gymId = req.query.gym_id as string | undefined;
  const q = ((req.query.q as string) ?? '').trim();

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

    // Members: all active (non-deleted) members in this gym regardless of Clerk account
    const { rows: memberRows } = await db.query<{
      id: number; name: string; gym_id: string; clerk_user_id: string | null;
    }>(
      `SELECT m.id, m.name, m.gym_id, m.clerk_user_id
       FROM members m
       WHERE m.gym_id = ?
         AND m.deleted_at IS NULL
         AND m.name LIKE ?
       ORDER BY m.name ASC
       LIMIT 50`,
      [gymId, like],
    );

    // Filter out other superadmins from staff list (requires Clerk lookup)
    const staffFiltered: any[] = [];
    for (const s of staffRows) {
      try {
        const u = await clerkClient.users.getUser(s.user_id);
        if ((u.publicMetadata as any)?.platform_role === 'superadmin') continue;
        staffFiltered.push({ id: s.user_id, name: s.name, type: 'staff', role: s.role, gymId: s.gym_id });
      } catch { /* skip users that no longer exist in Clerk */ }
    }

    // Exclude caller from members list (if the superadmin also has a member row)
    // and exclude members whose clerk_user_id matches a staff row (already included above)
    const staffUserIds = new Set(staffFiltered.map((s) => s.id));
    const members = memberRows
      .filter((m) => m.clerk_user_id !== adminId)
      .filter((m) => !m.clerk_user_id || !staffUserIds.has(m.clerk_user_id))
      .map((m) => ({
        id: `member:${m.id}`,
        name: m.name,
        type: 'member' as const,
        role: 'member',
        gymId: m.gym_id,
      }));

    res.json([...staffFiltered, ...members]);
  } catch (err) { next(err); }
});

/**
 * POST /platform/impersonation/stop
 * Superadmin-only. Signals the end of an impersonation session.
 * Declared BEFORE /:targetId so it isn't swallowed by the dynamic segment.
 */
impersonationRouter.post('/stop', requireSuperadmin, async (req, res, next) => {
  const { impersonated_user_id, impersonated_user_name, impersonated_role, duration_seconds } = req.body ?? {};

  if (!impersonated_user_id) return res.status(400).json({ error: 'impersonated_user_id required' });

  try {
    void { impersonated_user_name, impersonated_role, duration_seconds };
    res.status(204).send();
  } catch (err) { next(err); }
});

/**
 * POST /platform/impersonation/:targetId
 * Superadmin-only. Validates the target and returns the effective identity.
 * Body: { targetType: 'member' | 'staff' }
 * For members: targetId is members.id; returns id as "member:<id>".
 * For staff: targetId is gym_memberships.user_id (Clerk user ID).
 */
impersonationRouter.post('/:targetId', requireSuperadmin, async (req, res, next) => {
  const adminId = req.auth!.userId;
  const targetId = String(req.params.targetId);
  const gymId = req.headers['x-gym-id'] as string | undefined;
  const { targetType } = req.body as { targetType?: string };

  if (!gymId) return res.status(400).json({ error: 'x-gym-id header required' });
  if (!targetType || !['member', 'staff'].includes(targetType)) {
    return res.status(400).json({ error: 'targetType must be "member" or "staff"' });
  }

  try {
    if (targetType === 'member') {
      const memberId = Number(targetId);
      if (!memberId) return res.status(400).json({ error: 'Invalid member target ID' });

      // Cannot impersonate yourself (check if the caller's member row matches)
      const { rows: selfRows } = await db.query<{ id: number }>(
        'SELECT id FROM members WHERE id = ? AND clerk_user_id = ?',
        [memberId, adminId],
      );
      if (selfRows[0]) return res.status(400).json({ error: 'Cannot impersonate yourself' });

      const { rows } = await db.query<{ id: number; name: string; gym_id: string }>(
        `SELECT m.id, m.name, m.gym_id FROM members m
         WHERE m.id = ? AND m.gym_id = ? AND m.deleted_at IS NULL`,
        [memberId, gymId],
      );
      if (!rows[0]) return res.status(400).json({ error: 'Member not found or not active in this gym' });

      res.json({
        id: `member:${rows[0].id}`,
        name: rows[0].name,
        role: 'member',
        gym_id: rows[0].gym_id,
        gymIds: [rows[0].gym_id],
      });
      return;
    }

    // Staff impersonation
    if (targetId === adminId) return res.status(400).json({ error: 'Cannot impersonate yourself' });

    const targetUser = await clerkClient.users.getUser(targetId).catch(() => null);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if ((targetUser.publicMetadata as any)?.platform_role === 'superadmin') {
      return res.status(400).json({ error: 'Cannot impersonate another superadmin' });
    }

    const { rows } = await db.query<{ id: number; role: string; name: string }>(
      `SELECT gm.id, gm.role, gm.name FROM gym_memberships gm
       WHERE gm.user_id = ? AND gm.gym_id = ? AND gm.status = 'active'`,
      [targetId, gymId],
    );

    if (!rows[0]) return res.status(400).json({ error: 'Target user has no active membership in this gym' });

    const { rows: gymRows } = await db.query<{ gym_id: string }>(
      `SELECT gym_id FROM gym_memberships WHERE user_id = ? AND status = 'active'`,
      [targetId],
    );

    res.json({
      id: targetId,
      name: rows[0].name,
      role: rows[0].role,
      gym_id: gymId,
      gymIds: gymRows.map((r) => r.gym_id),
    });
  } catch (err) { next(err); }
});
