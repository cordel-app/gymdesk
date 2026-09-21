import { Router } from 'express';
import { requireSuperadmin } from '../infra/tenantContext';
import { db } from '../infra/db';

export const impersonationRouter = Router();

/**
 * GET /platform/impersonation/targets?q=<search>&gym_id=<id>&type=<staff|member>
 * Superadmin-only. Returns active members + staff for the given gym, excluding
 * the caller. Staff discovery is entirely database-driven (gym_memberships) —
 * no Clerk lookup. Used by both the Admin app's Impersonate dialog (which must
 * only ever see `type=staff` results — #504) and the Member app's impersonation
 * dialog (which only wants `type=member`). `type` is optional and, when
 * omitted, preserves the original combined behavior for backward compatibility.
 * Members are eligible regardless of whether they have a Clerk account.
 *
 * #592: staff targets are the gym's active logins enriched with the Staff
 * record linked to them (`staff.gym_membership_id`), so the dialog shows the
 * Staff Members page's names and profiles. A login with no Staff record (the
 * gym owner's admin membership created at gym creation) is still listed under
 * its membership name; a Staff record with no login is not — there is no
 * identity to impersonate.
 */
impersonationRouter.get('/targets', requireSuperadmin, async (req, res, next) => {
  const adminId = req.auth!.userId;
  const gymId = req.query.gym_id as string | undefined;
  const q = ((req.query.q as string) ?? '').trim();
  const type = req.query.type as string | undefined;

  if (!gymId) return res.status(400).json({ error: 'gym_id query param required' });
  if (type && !['staff', 'member'].includes(type)) {
    return res.status(400).json({ error: 'type must be "staff" or "member"' });
  }

  try {
    const like = `%${q}%`;

    // Staff: all gym_memberships rows with non-member roles (no status filter — status is informational only),
    // LEFT JOINed to the Staff record that owns the login (#592). Display name prefers the Staff
    // record's first/last name; gym_memberships.name is nullable (legacy grants had none), so fall
    // back to it, then email, then user_id for both matching and display — `NULL LIKE ?` is NULL,
    // not true, so a plain `name LIKE ?` would silently drop those rows (#364).
    const staffRows = type === 'member' ? [] : (await db.query<{
      user_id: string; name: string; email: string | null; role: string; gym_id: string; status: string;
      profile: string | null; staff_id: number | null;
    }>(
      `SELECT gm.user_id,
              COALESCE(CONCAT(s.first_name, ' ', s.last_name), gm.name, gm.email, gm.user_id) AS name,
              COALESCE(s.email, gm.email) AS email,
              gm.role, gm.gym_id, gm.status, s.profile, s.id AS staff_id
       FROM gym_memberships gm
       LEFT JOIN staff s ON s.gym_membership_id = gm.id AND s.deleted_at IS NULL
       WHERE gm.gym_id = ?
         AND gm.user_id != ?
         AND gm.role != 'member'
         AND COALESCE(CONCAT(s.first_name, ' ', s.last_name), gm.name, gm.email, gm.user_id) LIKE ?
       ORDER BY name ASC
       LIMIT 50`,
      [gymId, adminId, like],
    )).rows;

    // Members: all active (non-deleted) members in this gym regardless of Clerk account
    const memberRows = type === 'staff' ? [] : (await db.query<{
      id: number; name: string; email: string | null; gym_id: string; clerk_user_id: string | null;
    }>(
      `SELECT m.id, m.name, m.email, m.gym_id, m.clerk_user_id
       FROM members m
       WHERE m.gym_id = ?
         AND m.deleted_at IS NULL
         AND m.name LIKE ?
       ORDER BY m.name ASC
       LIMIT 50`,
      [gymId, like],
    )).rows;

    // Staff targets come straight from gym_memberships — no Clerk lookup. Superadmins
    // are excluded because they carry no gym_memberships row (see tenantContext.ts:
    // "gymMembershipId: null for superadmins with no membership row").
    const staffFiltered = staffRows.map((s) => (
      { id: s.user_id, name: s.name, email: s.email, type: 'staff', role: s.role, status: s.status, gymId: s.gym_id, profile: s.profile, staffId: s.staff_id }
    ));

    // Exclude caller from members list (if the superadmin also has a member row)
    // and exclude members whose clerk_user_id matches a staff row (already included above)
    const staffUserIds = new Set(staffFiltered.map((s) => s.id));
    const members = memberRows
      .filter((m) => m.clerk_user_id !== adminId)
      .filter((m) => !m.clerk_user_id || !staffUserIds.has(m.clerk_user_id))
      .map((m) => ({
        id: `member:${m.id}`,
        name: m.name,
        email: m.email,
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
      // targetId arrives as "member:<N>" from the /targets list; strip the prefix before parsing
      const rawId = targetId.startsWith('member:') ? targetId.slice(7) : targetId;
      const memberId = Number(rawId);
      if (!memberId || !Number.isInteger(memberId)) return res.status(400).json({ error: 'Invalid member target ID' });

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

    // No Clerk lookup: gym_memberships is the sole source of truth. Superadmins carry
    // no gym_memberships row, so a superadmin target simply fails the lookup below with
    // "no membership in this gym" rather than needing an explicit superadmin check.
    const { rows } = await db.query<{ id: number; role: string; name: string; status: string }>(
      `SELECT gm.id, gm.role, gm.status,
              COALESCE(CONCAT(s.first_name, ' ', s.last_name), gm.name, gm.email, gm.user_id) AS name
       FROM gym_memberships gm
       LEFT JOIN staff s ON s.gym_membership_id = gm.id AND s.deleted_at IS NULL
       WHERE gm.user_id = ? AND gm.gym_id = ?`,
      [targetId, gymId],
    );

    if (!rows[0]) return res.status(400).json({ error: 'Target user has no membership in this gym' });
    // A pending invitation is a placeholder row (`invited_<ts>`), not a Clerk user:
    // tenantContext could never resolve it, so every request of the session would
    // fail with "Impersonation target not found". Refuse up front instead.
    if (rows[0].status === 'invited' || targetId.startsWith('invited_')) {
      return res.status(400).json({ error: 'This staff member has not accepted their invitation yet.' });
    }

    const { rows: gymRows } = await db.query<{ gym_id: string }>(
      `SELECT gym_id FROM gym_memberships WHERE user_id = ?`,
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
