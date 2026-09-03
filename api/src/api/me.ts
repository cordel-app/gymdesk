import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { getTenantContext, requireRole, TenantContext } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import { bookMemberOnSession, cancelBooking } from './bookings';
import { validateAndInsertRequest } from './shared-training-requests';
import { PLAN_TREE_SELECT } from './training-plans';
import { insertAndFetch } from '../infra/db-helpers';
import { sendNotification } from '../infra/notifications';
import { getPaymentProvider } from '../payments';
import { generateReceiptPdf } from '../lib/receipt-pdf';

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

export const meRouter = Router();

// Called once on first sign-in: links Clerk user to members row and creates gym_memberships entry.
// Does NOT use tenantContext — the membership row doesn't exist yet.
export const meLinkRouter = Router();

// #68: resolves the gym + theme for the caller without requiring x-gym-id.
// Used by the member app on first load to bootstrap gymId and apply theming.
export const meGymRouter = Router();

meGymRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const callerUserId = req.auth?.userId;
  if (!callerUserId) return res.status(401).json({ error: 'Unauthorized' });

  const impersonateAs = req.headers['x-impersonate-as'] as string | undefined;
  const isMemberImpersonation = !!impersonateAs && impersonateAs.startsWith('member:');
  const isStaffImpersonation = !!impersonateAs && !isMemberImpersonation && impersonateAs !== callerUserId;

  // Verify caller is superadmin before honoring impersonation header
  let isSuperadmin = false;
  if (impersonateAs && impersonateAs !== callerUserId) {
    try {
      const caller = await clerkClient.users.getUser(callerUserId);
      isSuperadmin = (caller.publicMetadata as any)?.platform_role === 'superadmin';
    } catch { /* proceed with caller's own gym */ }
  }

  try {
    let rows: any[];

    if (isSuperadmin && isMemberImpersonation) {
      // Member impersonation: look up directly by members.id (no gym_memberships join needed)
      const memberId = Number(impersonateAs!.slice(7));
      ({ rows } = await db.query(
        `SELECT g.id, g.name,
                t.id AS theme_id_val, t.name AS theme_name, t.status AS theme_status,
                t.logo_mime AS theme_logo_mime, t.logo_updated_at AS theme_logo_updated_at,
                t.tokens AS theme_tokens
         FROM members m
         JOIN gyms g ON g.id = m.gym_id
         LEFT JOIN themes t ON t.id = g.theme_id AND t.deleted_at IS NULL
         WHERE m.id = ? AND m.deleted_at IS NULL
         LIMIT 1`,
        [memberId],
      ));
    } else if (isSuperadmin && isStaffImpersonation) {
      // Staff impersonation: staff may not have a members row, so start from gym_memberships.
      // Prefer the gym from x-gym-id if present (set by the frontend after impersonation starts).
      const gymId = req.headers['x-gym-id'] as string | undefined;
      ({ rows } = await db.query(
        `SELECT g.id, g.name,
                t.id AS theme_id_val, t.name AS theme_name, t.status AS theme_status,
                t.logo_mime AS theme_logo_mime, t.logo_updated_at AS theme_logo_updated_at,
                t.tokens AS theme_tokens
         FROM gym_memberships gm
         JOIN gyms g ON g.id = gm.gym_id
         LEFT JOIN themes t ON t.id = g.theme_id AND t.deleted_at IS NULL
         WHERE gm.user_id = ? AND gm.status = 'active'
           ${gymId ? 'AND gm.gym_id = ?' : ''}
         LIMIT 1`,
        gymId ? [impersonateAs, gymId] : [impersonateAs],
      ));
    } else {
      // Normal (non-impersonation): look up by clerk_user_id via members table
      ({ rows } = await db.query(
        `SELECT g.id, g.name,
                t.id AS theme_id_val, t.name AS theme_name, t.status AS theme_status,
                t.logo_mime AS theme_logo_mime, t.logo_updated_at AS theme_logo_updated_at,
                t.tokens AS theme_tokens
         FROM members m
         JOIN gym_memberships gm ON gm.gym_id = m.gym_id AND gm.user_id = m.clerk_user_id
         JOIN gyms g ON g.id = m.gym_id
         LEFT JOIN themes t ON t.id = g.theme_id AND t.deleted_at IS NULL
         WHERE m.clerk_user_id = ? AND m.deleted_at IS NULL
         LIMIT 1`,
        [callerUserId],
      ));
    }

    if (rows.length === 0) return res.status(404).json({ error: 'No gym found for this user' });
    const row = rows[0];
    const theme = row.theme_id_val ? {
      id: row.theme_id_val,
      name: row.theme_name,
      status: row.theme_status,
      has_logo: !!row.theme_logo_mime,
      logo_updated_at: row.theme_logo_updated_at,
      tokens: typeof row.theme_tokens === 'string' ? JSON.parse(row.theme_tokens) : (row.theme_tokens ?? null),
    } : null;
    res.json({ id: row.id, name: row.name, theme });
  } catch (err) { next(err); }
});

meLinkRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.auth?.userId;
  const gymId = req.headers['x-gym-id'] as string | undefined;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
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
        'UPDATE members SET clerk_user_id = ?, invitation_id = NULL WHERE id = ?',
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
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows } = await db.query(
      `SELECT m.*, m.membership_plan_id AS fare_id,
              p.name AS fare_name, p.base_price AS fare_price
       FROM members m
       LEFT JOIN membership_plans p ON p.id = m.membership_plan_id
       WHERE m.gym_id = ? AND m.id = ? AND m.deleted_at IS NULL`,
      [gymId, memberId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

meRouter.patch('/profile', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const { phone } = req.body as { phone?: string };
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rowCount } = await db.query(
      `UPDATE members SET phone = COALESCE(?, phone)
       WHERE gym_id = ? AND id = ? AND deleted_at IS NULL`,
      [phone ?? null, gymId, memberId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Member not found' });
    const { rows } = await db.query(
      `SELECT m.*, m.membership_plan_id AS fare_id,
              p.name AS fare_name, p.base_price AS fare_price
       FROM members m
       LEFT JOIN membership_plans p ON p.id = m.membership_plan_id
       WHERE m.gym_id = ? AND m.id = ? AND m.deleted_at IS NULL`,
      [gymId, memberId],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// #59: the centers this member is assigned to, so the member app can
// resolve a default and (if there's more than one) offer a switcher.
meRouter.get('/centers', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows } = await db.query(
      `SELECT c.id, c.name, mc.is_default
       FROM member_centers mc
       JOIN centers c ON c.id = mc.center_id
       WHERE mc.member_id = ? AND mc.deleted_at IS NULL AND c.deleted_at IS NULL
       ORDER BY mc.is_default DESC, c.name ASC`,
      [memberId],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

meRouter.get('/bookings', requireRole('member'), requireFeatureEnabled('calendar.calendar'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows } = await db.query(
      `SELECT b.id, b.status, b.waitlist_position, b.booked_at, b.cancelled_at,
              b.class_session_id,
              cs.starts_at, cs.ends_at, cs.status AS session_status,
              ct.name AS class_name, ct.description
       FROM bookings b
       JOIN class_sessions cs ON cs.id = b.class_session_id
       JOIN class_types ct ON ct.id = cs.class_type_id
       WHERE b.gym_id = ? AND b.member_id = ?
       ORDER BY cs.starts_at ASC`,
      [gymId, memberId],
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
meRouter.get('/schedule', requireRole('member'), requireFeatureEnabled('calendar.calendar'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    let memberId: number;
    try { memberId = await resolveMemberId(gymId, ctx); } catch { return res.json([]); }

    const from = (req.query.from as string) || new Date().toISOString();
    const to = req.query.to as string | undefined;
    const where: string[] = ["cs.gym_id = ?", "cs.status = 'scheduled'", "cs.starts_at >= ?"];
    const params: any[] = [gymId, from];
    if (to) { where.push('cs.starts_at <= ?'); params.push(to); }

    const { rows } = await db.query(
      `SELECT cs.id, cs.activity_type_id, cs.starts_at, cs.ends_at,
              cs.sharing_authorized,
              at.name AS class_type_name, at.description AS class_type_description,
              at.shareable,
              sp.name AS space_name,
              tm.name AS trainer_name,
              COALESCE(cs.max_capacity_override, at.max_capacity) AS effective_capacity,
              CASE
                WHEN cs.trainer_membership_id IS NOT NULL AND cs.space_id IS NOT NULL
                THEN LEAST(COALESCE(tm.max_concurrent_groups, 1), COALESCE(sp.max_concurrent_groups, 1))
                ELSE 1
              END AS effective_max_groups,
              CASE
                WHEN cs.trainer_membership_id IS NOT NULL AND cs.space_id IS NOT NULL
                THEN (
                  SELECT COUNT(*) FROM class_sessions cs2
                  WHERE cs2.gym_id = cs.gym_id
                    AND cs2.trainer_membership_id = cs.trainer_membership_id
                    AND cs2.space_id = cs.space_id
                    AND cs2.starts_at = cs.starts_at AND cs2.ends_at = cs.ends_at
                    AND cs2.status <> 'cancelled' AND cs2.deleted_at IS NULL
                )
                ELSE 1
              END AS concurrent_groups_count,
              (
                SELECT COUNT(*) FROM bookings b
                WHERE b.class_session_id = cs.id AND b.status = 'booked'
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
       JOIN activity_types at ON at.id = cs.activity_type_id
       LEFT JOIN spaces sp ON sp.id = cs.space_id
       LEFT JOIN gym_memberships tm ON tm.id = cs.trainer_membership_id
       WHERE ${where.join(' AND ')}
       ORDER BY cs.starts_at ASC`,
      [memberId, memberId, memberId, memberId, ...params],
    );
    const now = new Date();
    const shaped = rows.map((r: any) => ({
      ...r,
      spots_left: Math.max(0, Number(r.effective_capacity) - Number(r.booked_count)),
      access_locked: !!Number(r.access_locked),
      shareable: !!Number(r.shareable),
      sharing_authorized: !!Number(r.sharing_authorized),
      can_request_sharing: !!Number(r.shareable) &&
        !Number(r.sharing_authorized) &&
        Number(r.concurrent_groups_count) < Number(r.effective_max_groups),
      can_cancel: new Date(r.starts_at) > now,
    }));
    res.json(shaped);
  } catch (err) { next(err); }
});

/** Book self on a session. Returns the booking with booked/waitlisted status. */
meRouter.post('/bookings', requireRole('member'), requireFeatureEnabled('calendar.calendar'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const { class_session_id } = req.body;
  if (!class_session_id) return res.status(400).json({ error: 'class_session_id is required' });
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const result = await bookMemberOnSession(gymId, memberId, Number(class_session_id));
    // Notify fire-and-forget
    db.query(
      `SELECT at.name AS title, cs.starts_at FROM class_sessions cs
       JOIN activity_types at ON at.id = cs.activity_type_id WHERE cs.id = ?`,
      [class_session_id],
    ).then(({ rows: si }: any) => {
      if (si.length > 0) {
        sendNotification(gymId, memberId,
          result.status === 'booked' ? 'booking_confirmed' : 'waitlist_joined',
          'session', Number(class_session_id),
          { title: si[0].title, starts_at: si[0].starts_at });
      }
    }).catch(() => {});
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
meRouter.get('/class-packages', requireRole('member'), requireFeatureEnabled('organization.class_packages'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows } = await db.query(
      `SELECT ucp.id, ucp.sessions_remaining, ucp.expires_at, ucp.purchased_at, ucp.status,
              cp.name AS package_name, cp.number_of_sessions AS package_sessions, cp.price AS package_price
       FROM user_class_packages ucp
       JOIN class_packages cp ON cp.id = ucp.class_package_id
       WHERE ucp.gym_id = ? AND ucp.member_id = ?
       ORDER BY ucp.purchased_at DESC`,
      [gymId, memberId],
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
meRouter.delete('/bookings/:id', requireRole('member'), requireFeatureEnabled('calendar.calendar'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId, gymMembershipId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows } = await db.query(
      `SELECT b.id, b.class_session_id, cs.starts_at,
              at.name AS title
       FROM bookings b
       JOIN class_sessions cs ON cs.id = b.class_session_id
       JOIN activity_types at ON at.id = cs.activity_type_id
       WHERE b.id = ? AND b.gym_id = ? AND b.member_id = ?`,
      [req.params.id, gymId, memberId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });
    if (new Date(rows[0].starts_at) <= new Date()) {
      return res.status(400).json({ error: 'Cannot cancel a booking after the session has started.' });
    }
    const cancelResult = await cancelBooking(gymId, Number(req.params.id), gymMembershipId);
    if (cancelResult.promotedMemberId) {
      sendNotification(gymId, cancelResult.promotedMemberId, 'promoted_from_waitlist', 'session',
        rows[0].class_session_id, { title: rows[0].title, starts_at: rows[0].starts_at });
    }
    res.status(204).send();
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** #323: Create a shared training request from a member. */
meRouter.post('/shared-training-requests', requireRole('member'), requireFeatureEnabled('calendar.calendar'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const { host_session_id, requested_activity_type_id, notes } = req.body;
  if (!host_session_id || !requested_activity_type_id) {
    return res.status(400).json({ error: 'host_session_id and requested_activity_type_id are required' });
  }
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    await validateAndInsertRequest(gymId, {
      host_session_id: Number(host_session_id),
      requested_activity_type_id: Number(requested_activity_type_id),
      requesting_member_id: memberId,
      notes,
      gymMembershipId: ctx.gymMembershipId,
    });
    const { rows } = await db.query(
      `SELECT str.*, at_req.name AS requested_activity_name, cs.starts_at AS session_starts_at, cs.ends_at AS session_ends_at
       FROM shared_training_requests str
       JOIN activity_types at_req ON at_req.id = str.requested_activity_type_id
       JOIN class_sessions cs ON cs.id = str.host_session_id
       WHERE str.gym_id = ? AND str.requesting_member_id = ? ORDER BY str.id DESC LIMIT 1`,
      [gymId, memberId],
    );
    res.status(201).json(rows[0]);
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

/** #323: Member views their own shared training requests. */
meRouter.get('/shared-training-requests', requireRole('member'), requireFeatureEnabled('calendar.calendar'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows } = await db.query(
      `SELECT str.*, at_req.name AS requested_activity_name, at_host.name AS host_activity_name,
              cs.starts_at AS session_starts_at, cs.ends_at AS session_ends_at,
              sp.name AS space_name, gm_t.name AS trainer_name
       FROM shared_training_requests str
       JOIN activity_types at_req ON at_req.id = str.requested_activity_type_id
       JOIN class_sessions cs     ON cs.id = str.host_session_id
       JOIN activity_types at_host ON at_host.id = cs.activity_type_id
       LEFT JOIN spaces sp         ON sp.id = cs.space_id
       LEFT JOIN gym_memberships gm_t ON gm_t.id = cs.trainer_membership_id
       WHERE str.gym_id = ? AND str.requesting_member_id = ?
       ORDER BY str.created_at DESC`,
      [gymId, memberId],
    );
    res.json(rows);
  } catch (e) { next(e); }
});

/**
 * #55: caller's active training plans (plural — a member can have several
 * active plans at once), each with its full clone tree (workouts -> blocks
 * -> exercises).
 */
meRouter.get('/training-plans', requireRole('member'), requireFeatureEnabled('training.training_plans'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    let memberId: number;
    try { memberId = await resolveMemberId(gymId, ctx); } catch { return res.json([]); }
    const { rows } = await db.query(
      `${PLAN_TREE_SELECT}
       JOIN member_training_plans mtp ON mtp.training_plan_id = tp.id
       WHERE tp.gym_id = ? AND tp.member_id = ? AND mtp.status = 'active' AND tp.status != 'deleted'
       ORDER BY mtp.created_at DESC`,
      [gymId, memberId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/**
 * Resolves members.id from TenantContext.
 * For member impersonation (effectiveType === 'member'), effectiveUserId is already members.id.
 * For all other cases, resolves via clerk_user_id.
 */
async function resolveMemberId(gymId: string, ctx: TenantContext): Promise<number> {
  if (ctx.effectiveType === 'member') {
    const id = Number(ctx.effectiveUserId);
    const { rows } = await db.query(
      'SELECT id FROM members WHERE gym_id = ? AND id = ? AND deleted_at IS NULL',
      [gymId, id],
    );
    if (rows.length === 0) throw Object.assign(new Error('Member profile not found'), { status: 404 });
    return rows[0].id;
  }
  const { rows } = await db.query(
    'SELECT id FROM members WHERE gym_id = ? AND clerk_user_id = ? AND deleted_at IS NULL',
    [gymId, ctx.effectiveUserId],
  );
  if (rows.length === 0) throw Object.assign(new Error('Member profile not found'), { status: 404 });
  return rows[0].id;
}

/**
 * #55: log a performed exercise + its sets. Member can only log against a
 * WorkoutExercise that belongs to one of their own (non-deleted) TrainingPlans.
 */
meRouter.post('/exercise-logs', requireRole('member'), requireFeatureEnabled('training'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const { workout_exercise_id, logged_date, notes, duration_seconds, skipped, sets } = req.body;
  if (!workout_exercise_id || !logged_date) {
    return res.status(400).json({ error: 'workout_exercise_id and logged_date are required' });
  }
  if (sets != null && !Array.isArray(sets)) return res.status(400).json({ error: 'sets must be an array' });
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows: weRows } = await db.query(
      `SELECT we.exercise_id FROM workout_exercises we
       JOIN workout_blocks wb ON wb.id = we.workout_block_id
       JOIN workouts w ON w.id = wb.workout_id
       JOIN training_plans tp ON tp.id = w.training_plan_id
       WHERE we.id = ? AND we.gym_id = ? AND tp.member_id = ? AND we.deleted_at IS NULL`,
      [workout_exercise_id, gymId, memberId],
    );
    if (weRows.length === 0) return res.status(403).json({ error: 'You can only log against your own training plan.' });
    const exerciseId = weRows[0].exercise_id;

    const logId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO exercise_logs (gym_id, member_id, workout_exercise_id, exercise_id, logged_date, notes, duration_seconds, skipped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [gymId, memberId, workout_exercise_id, exerciseId, logged_date, notes ?? null,
         duration_seconds ?? null, Boolean(skipped)],
      );
      if (Array.isArray(sets)) {
        for (let i = 0; i < sets.length; i++) {
          const s = sets[i];
          await tx.query(
            'INSERT INTO exercise_log_sets (gym_id, exercise_log_id, set_number, weight, reps, rpe) VALUES (?, ?, ?, ?, ?, ?)',
            [gymId, insertId, s.set_number ?? i + 1, s.weight ?? null, s.reps ?? null, s.rpe ?? null],
          );
        }
      }
      return insertId;
    });
    const { rows } = await db.query(
      `SELECT el.*, (SELECT JSON_ARRAYAGG(item) FROM (
                       SELECT JSON_OBJECT('id', s.id, 'set_number', s.set_number, 'weight', s.weight, 'reps', s.reps, 'rpe', s.rpe) AS item
                       FROM exercise_log_sets s WHERE s.exercise_log_id = el.id ORDER BY s.set_number
                     ) t) AS sets
       FROM exercise_logs el WHERE el.id = ?`,
      [logId],
    );
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** #55: member edits their own log (ownership-checked). No DELETE route. */
meRouter.put('/exercise-logs/:id', requireRole('member'), requireFeatureEnabled('training'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const { notes, duration_seconds, skipped, sets } = req.body;
  if (sets != null && !Array.isArray(sets)) return res.status(400).json({ error: 'sets must be an array' });
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    await db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE exercise_logs SET
          notes = IF(?, ?, notes), duration_seconds = IF(?, ?, duration_seconds), skipped = COALESCE(?, skipped),
          modified_at = UTC_TIMESTAMP(), modified_by_member_id = ?
         WHERE id = ? AND gym_id = ? AND member_id = ?`,
        ['notes' in req.body ? 1 : 0, notes ?? null, 'duration_seconds' in req.body ? 1 : 0, duration_seconds ?? null,
         skipped ?? null, memberId, req.params.id, gymId, memberId],
      );
      if (rowCount === 0) throw Object.assign(new Error('Log not found'), { status: 404 });
      if (Array.isArray(sets)) {
        await tx.query('DELETE FROM exercise_log_sets WHERE exercise_log_id = ? AND gym_id = ?', [req.params.id, gymId]);
        for (let i = 0; i < sets.length; i++) {
          const s = sets[i];
          await tx.query(
            'INSERT INTO exercise_log_sets (gym_id, exercise_log_id, set_number, weight, reps, rpe) VALUES (?, ?, ?, ?, ?, ?)',
            [gymId, req.params.id, s.set_number ?? i + 1, s.weight ?? null, s.reps ?? null, s.rpe ?? null],
          );
        }
      }
    });
    const { rows } = await db.query(
      `SELECT el.*, (SELECT JSON_ARRAYAGG(item) FROM (
                       SELECT JSON_OBJECT('id', s.id, 'set_number', s.set_number, 'weight', s.weight, 'reps', s.reps, 'rpe', s.rpe) AS item
                       FROM exercise_log_sets s WHERE s.exercise_log_id = el.id ORDER BY s.set_number
                     ) t) AS sets
       FROM exercise_logs el WHERE el.id = ?`,
      [req.params.id],
    );
    res.json(rows[0]);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** #55: history for progress charts — filter by exercise id. */
meRouter.get('/exercise-logs', requireRole('member'), requireFeatureEnabled('training'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const exerciseId = req.query.exercise as string | undefined;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const params: any[] = [gymId, memberId];
    let sql = `SELECT el.*, e.name AS exercise_name,
                      (SELECT JSON_ARRAYAGG(item) FROM (
                         SELECT JSON_OBJECT('id', s.id, 'set_number', s.set_number, 'weight', s.weight, 'reps', s.reps, 'rpe', s.rpe) AS item
                         FROM exercise_log_sets s WHERE s.exercise_log_id = el.id ORDER BY s.set_number
                       ) t) AS sets
               FROM exercise_logs el JOIN exercises e ON e.id = el.exercise_id
               WHERE el.gym_id = ? AND el.member_id = ?`;
    if (exerciseId) { sql += ' AND el.exercise_id = ?'; params.push(exerciseId); }
    sql += ' ORDER BY el.logged_date DESC, el.id DESC';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * #55: log completion of a workout block. result_type is read server-side
 * from the block's own configuration — never trusted from the client.
 */
meRouter.post('/workout-block-logs', requireRole('member'), requireFeatureEnabled('training'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const { workout_block_id, logged_date, started_at, finished_at, result_value, notes } = req.body;
  if (!workout_block_id || !logged_date) {
    return res.status(400).json({ error: 'workout_block_id and logged_date are required' });
  }
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows: blockRows } = await db.query(
      `SELECT wb.result_type FROM workout_blocks wb
       JOIN workouts w ON w.id = wb.workout_id
       JOIN training_plans tp ON tp.id = w.training_plan_id
       WHERE wb.id = ? AND wb.gym_id = ? AND tp.member_id = ? AND wb.deleted_at IS NULL`,
      [workout_block_id, gymId, memberId],
    );
    if (blockRows.length === 0) return res.status(403).json({ error: 'You can only log against your own training plan.' });

    const row = await insertAndFetch(
      `INSERT INTO workout_block_logs (gym_id, member_id, workout_block_id, logged_date, started_at, finished_at, result_type, result_value, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, memberId, workout_block_id, logged_date, started_at ?? null, finished_at ?? null,
       blockRows[0].result_type, result_value ?? null, notes ?? null],
      'SELECT * FROM workout_block_logs WHERE id = ?',
      (id) => [id],
    );
    res.status(201).json(row);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** #55: member edits their own block log (ownership-checked). No DELETE route. */
meRouter.put('/workout-block-logs/:id', requireRole('member'), requireFeatureEnabled('training'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const { started_at, finished_at, result_value, notes } = req.body;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rowCount } = await db.query(
      `UPDATE workout_block_logs SET
        started_at = IF(?, ?, started_at), finished_at = IF(?, ?, finished_at),
        result_value = IF(?, ?, result_value), notes = IF(?, ?, notes),
        modified_at = UTC_TIMESTAMP(), modified_by_member_id = ?
       WHERE id = ? AND gym_id = ? AND member_id = ?`,
      ['started_at' in req.body ? 1 : 0, started_at ?? null,
       'finished_at' in req.body ? 1 : 0, finished_at ?? null,
       'result_value' in req.body ? 1 : 0, result_value ?? null,
       'notes' in req.body ? 1 : 0, notes ?? null,
       memberId, req.params.id, gymId, memberId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Log not found' });
    const { rows } = await db.query('SELECT * FROM workout_block_logs WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** #55: history list. */
meRouter.get('/workout-block-logs', requireRole('member'), requireFeatureEnabled('training'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows } = await db.query(
      'SELECT * FROM workout_block_logs WHERE gym_id = ? AND member_id = ? ORDER BY logged_date DESC, id DESC',
      [gymId, memberId],
    );
    res.json(rows);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** P4.5: names of promotions applied to the caller's current membership, if any. */
meRouter.get('/promotions', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.description
       FROM user_membership_promotions ump
       JOIN promotions p ON p.id = ump.promotion_id
       JOIN user_memberships um ON um.id = ump.user_membership_id
       WHERE ump.gym_id = ? AND um.member_id = ?
         AND ump.status = 'applied' AND um.status = 'active'
       ORDER BY ump.applied_at DESC`,
      [gymId, memberId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// P1.8: current membership (single record) with plan + benefits inline. Returns
// { membership: {...} | null } — null when the member has none, so the client
// can render an empty state without treating 404 as an error.
meRouter.get('/membership', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows: mships } = await db.query(
      `SELECT um.id, um.member_id, um.membership_plan_id,
              um.base_price, um.final_price, um.discount_reason, um.discount_expires_at,
              um.starts_at, um.ends_at, um.status, um.created_at,
              p.name AS plan_name, p.description AS plan_description, p.base_price AS plan_base_price,
              bp.recurring_billing_interval AS billing_interval,
              bp.recurring_billing_unit AS billing_unit
       FROM user_memberships um
       LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
       LEFT JOIN billing_policies bp ON bp.membership_plan_id = um.membership_plan_id AND bp.gym_id = um.gym_id
       WHERE um.gym_id = ? AND um.member_id = ?
       ORDER BY
         FIELD(um.status, 'active','paused','expired','cancelled'),
         um.starts_at DESC
       LIMIT 1`,
      [gymId, memberId],
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


/** #194: member's in-app notifications, newest first. */
meRouter.get('/notifications', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? 50), 10) || 50, 1), 100);
    const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
    const { rows } = await db.query(
      `SELECT id, type, entity_type, entity_id, payload, read_at, created_at
       FROM member_notifications
       WHERE gym_id = ? AND member_id = ?
       ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      [gymId, memberId],
    );
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) AS unread FROM member_notifications WHERE gym_id = ? AND member_id = ? AND read_at IS NULL',
      [gymId, memberId],
    );
    res.json({ items: rows, unread: Number(countRows[0].unread) });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** #194: unread notification count only (cheap poll for badge). */
meRouter.get('/notifications/count', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows } = await db.query(
      'SELECT COUNT(*) AS unread FROM member_notifications WHERE gym_id = ? AND member_id = ? AND read_at IS NULL',
      [gymId, memberId],
    );
    res.json({ unread: Number(rows[0].unread) });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** #194: mark all notifications read (must be before /:id/read to avoid param capture). */
meRouter.put('/notifications/read-all', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rowCount } = await db.query(
      'UPDATE member_notifications SET read_at = UTC_TIMESTAMP() WHERE gym_id = ? AND member_id = ? AND read_at IS NULL',
      [gymId, memberId],
    );
    res.json({ updated: rowCount });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** #194: mark a single notification read. */
meRouter.put('/notifications/:id/read', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rowCount } = await db.query(
      'UPDATE member_notifications SET read_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ? AND member_id = ? AND read_at IS NULL',
      [req.params.id, gymId, memberId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Notification not found or already read' });
    res.status(204).send();
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── Member payment requests ─────────────────────────────────────────────────

const memberPaymentRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  // Key on Clerk userId — all requests here are authenticated, so userId is always present.
  // Explicitly avoiding req.ip to prevent the express-rate-limit IPv6 validation warning.
  keyGenerator: (req) => (req as any).auth?.userId ?? 'unauthenticated',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many payment requests. Please try again later.' }),
});

/** Member's own payment request history. */
meRouter.get('/payment-requests', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows } = await db.query(
      `SELECT pr.id, pr.user_membership_id, pr.amount, pr.currency, pr.status,
              pr.provider, pr.source, pr.created_at, pr.completed_at,
              bp.recurring_billing_interval AS billing_interval,
              bp.recurring_billing_unit AS billing_unit
       FROM payment_requests pr
       LEFT JOIN user_memberships um ON um.id = pr.user_membership_id
       LEFT JOIN billing_policies bp ON bp.membership_plan_id = um.membership_plan_id AND bp.gym_id = pr.gym_id
       WHERE pr.gym_id = ? AND pr.member_id = ?
       ORDER BY pr.created_at DESC`,
      [gymId, memberId],
    );
    res.json(rows);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** Member self-initiates a payment for their active membership. Stamps consent_given_at. */
meRouter.post('/payment-requests', requireRole('member'), memberPaymentRateLimit as any, async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);

    const { rows: umRows } = await db.query<{ id: number; final_price: string; member_email: string }>(
      `SELECT um.id, um.final_price, m.email AS member_email
       FROM user_memberships um
       JOIN members m ON m.id = um.member_id
       WHERE um.gym_id = ? AND um.member_id = ? AND um.status = 'active'
       LIMIT 1`,
      [gymId, memberId],
    );
    if (!umRows[0]) return res.status(404).json({ error: 'No active membership found' });
    const um = umRows[0];

    const { rows: ctRows } = await db.query<{ id: number }>(
      `SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1`,
    );
    if (!ctRows[0]) return res.status(500).json({ error: 'charge_type membership_fee not configured' });

    const amount = Math.round(parseFloat(um.final_price) * 100);
    const orderId = crypto.randomUUID();
    const pageToken = crypto.randomUUID();
    const pageTokenExpires = new Date(Date.now() + 10 * 60 * 1000);

    req.log.info({ orderId, memberId, amount }, 'Member payment request created');

    const provider = getPaymentProvider();
    const result = await provider.createPaymentRequest({
      orderId,
      amount,
      currency: 'EUR',
      description: 'Membership fee',
      memberEmail: um.member_email,
      okUrl: process.env.PAYMENT_OK_URL ?? '',
      koUrl: process.env.PAYMENT_KO_URL ?? '',
      notificationUrl: process.env.PAYMENT_NOTIFICATION_URL ?? '',
    });

    req.log.info({ orderId, providerOrderId: result.providerOrderId }, 'Provider API call succeeded');

    const { insertId } = await db.query(
      `INSERT INTO payment_requests
         (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
          status, provider, provider_order, page_token, page_token_expires,
          consent_given_at, source)
       VALUES (?, ?, ?, ?, 'EUR', ?, 'pending', 'monei', ?, ?, ?, UTC_TIMESTAMP(), 'customer')`,
      [gymId, um.id, memberId, um.final_price, ctRows[0].id, orderId, pageToken, pageTokenExpires],
    );

    const checkoutUrl = `${process.env.PAYMENT_PAGE_URL ?? 'https://pay.vdicube.com'}/checkout?token=${pageToken}`;
    res.status(201).json({ id: insertId, checkoutUrl });
  } catch (err: any) {
    req.log.error({ err: (err as Error).message }, 'Member payment request creation failed');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** #194: upcoming confirmed bookings (sessions + events) within the next 30 days. */
meRouter.get('/upcoming', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const { rows: sessionRows } = await db.query(
      `SELECT b.id AS booking_id, 'session' AS kind,
              cs.id AS entity_id, at.name AS title, sp.name AS space_name,
              tm.name AS trainer_name, cs.starts_at, cs.ends_at
       FROM bookings b
       JOIN class_sessions cs ON cs.id = b.class_session_id
       JOIN activity_types at ON at.id = cs.activity_type_id
       LEFT JOIN spaces sp ON sp.id = cs.space_id
       LEFT JOIN gym_memberships tm ON tm.id = cs.trainer_membership_id
       WHERE b.gym_id = ? AND b.member_id = ? AND b.status = 'booked'
         AND cs.status = 'scheduled'
         AND cs.starts_at >= ? AND cs.starts_at <= ?
       ORDER BY cs.starts_at ASC`,
      [gymId, memberId, now, future],
    );

    res.json(sessionRows);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/** #194: past booking history (sessions + events), paginated. */
meRouter.get('/activity-history', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? 20), 10) || 20, 1), 100);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const cutoff = new Date().toISOString();

    const { rows: sessionRows } = await db.query(
      `SELECT b.id AS booking_id, 'session' AS kind,
              cs.id AS entity_id, at.name AS title,
              cs.starts_at, cs.ends_at, b.status AS booking_status,
              b.attendance_status, b.cancelled_at
       FROM bookings b
       JOIN class_sessions cs ON cs.id = b.class_session_id
       JOIN activity_types at ON at.id = cs.activity_type_id
       WHERE b.gym_id = ? AND b.member_id = ?
         AND cs.starts_at < ?
       ORDER BY cs.starts_at DESC`,
      [gymId, memberId, cutoff],
    );

    const items = sessionRows.slice(offset, offset + limit);
    res.json({ items, limit, offset });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// P1.8: read-only paginated ledger for the caller's own member row.
meRouter.get('/billing-events', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? 50), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? 0), 10) || 0, 0);
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM billing_events be WHERE be.gym_id = ? AND be.member_id = ?`,
      [gymId, memberId],
    );
    const { rows } = await db.query(
      `SELECT be.id, be.user_membership_id, be.event_type, be.previous_status, be.new_status,
              be.amount, be.notes, be.created_at, be.receipt_number,
              ct.code AS charge_type_code
       FROM billing_events be
       LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
       WHERE be.gym_id = ? AND be.member_id = ?
       ORDER BY be.created_at DESC, be.id DESC LIMIT ${limit} OFFSET ${offset}`,
      [gymId, memberId],
    );
    res.json({ items: rows, total: Number(countRows[0].total), limit, offset });
  } catch (err) {
    next(err);
  }
});

// Member downloads their own receipt PDF
meRouter.get('/receipts/:billingEventId', requireRole('member'), async (req: Request, res: Response, next: NextFunction) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  const billingEventId = parseInt(String(req.params.billingEventId), 10);
  if (!billingEventId) return res.status(400).json({ error: 'Invalid id' });

  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows: evRows } = await db.query<any>(
      `SELECT be.id, be.event_type, be.amount, be.receipt_number, be.receipt_issued_at,
              ct.code AS charge_type_code, m.name AS member_name
       FROM billing_events be
       LEFT JOIN charge_types ct ON ct.id = be.charge_type_id
       LEFT JOIN members m ON m.id = be.member_id
       WHERE be.id = ? AND be.gym_id = ? AND be.member_id = ?`,
      [billingEventId, gymId, memberId],
    );
    if (evRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const ev = evRows[0];
    if (!ev.receipt_number) return res.status(404).json({ error: 'Receipt not yet generated' });

    const { rows: gymRows } = await db.query<any>(
      'SELECT id, name, legal_name, cif, fiscal_address, fiscal_phone FROM gyms WHERE id = ?',
      [gymId],
    );
    const gym = gymRows[0];
    const { rows: taxRows } = await db.query<any>(
      "SELECT rate_percent AS rate FROM tax_rates WHERE gym_id = ? AND is_system = 1 AND status = 'active' LIMIT 1",
      [gymId],
    );
    const ivaRate = taxRows.length > 0 ? parseFloat(taxRows[0].rate) : 21;

    const pdfBuffer = await generateReceiptPdf({
      receiptNumber: ev.receipt_number,
      issuedAt: new Date(ev.receipt_issued_at),
      gym: {
        name: gym.name,
        legalName: gym.legal_name,
        cif: gym.cif,
        fiscalAddress: gym.fiscal_address,
        fiscalPhone: gym.fiscal_phone,
      },
      memberName: ev.member_name ?? 'Socio',
      concept: ev.charge_type_code ?? 'membership_fee',
      totalAmount: parseFloat(ev.amount),
      ivaRate,
      currency: 'EUR',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-${ev.receipt_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});
