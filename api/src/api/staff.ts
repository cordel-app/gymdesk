import { Router, Request, Response, NextFunction } from 'express';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { AppRole, STAFF_PROFILES, roleForProfile } from '../infra/permissions';
import {
  AccessError, MembershipRow, GrantStatus,
  getMembership, grantAccess, resendInvitation, revokeAccess, linkGymInvite, isPendingInvite,
} from '../infra/staff-access';

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

export const staffRouter = Router();
export const staffLinkRouter = Router();

/**
 * #592: every Staff record owns (at most) one gym_memberships row — the login
 * behind it — via `staff.gym_membership_id`. Access is granted on creation
 * with the role derived from the HR `profile` (see PROFILE_ROLE_MAP), kept in
 * sync on update, and revoked on deactivate/delete. The old Team page
 * (`gym-users.ts`) that used to manage gym_memberships directly is gone.
 */

function accessErrorToResponse(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof AccessError) return res.status(err.status).json({ error: err.message });
  return next(err);
}

async function loadStaff(id: unknown, gymId: string): Promise<any | null> {
  const { rows } = await db.query<any>(
    'SELECT * FROM staff WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [id, gymId],
  );
  return rows[0] ?? null;
}

async function linkedMembership(staffRow: any): Promise<MembershipRow | null> {
  return staffRow.gym_membership_id ? getMembership(staffRow.gym_membership_id) : null;
}

/** Self-edit + last-admin guards, carried over from the Team router. */
async function assertMembershipChange(
  req: Request,
  membership: MembershipRow,
  next: { role?: AppRole; remove?: boolean },
): Promise<string | null> {
  const { userId, gymId } = getTenantContext(req);
  if (membership.user_id === userId) {
    return next.remove
      ? 'Cannot revoke your own access — ask a peer admin.'
      : 'Cannot change your own role — ask a peer admin.';
  }
  const losesAdmin = membership.role === 'admin' && (next.remove || (next.role && next.role !== 'admin'));
  if (losesAdmin && !isPendingInvite(membership)) {
    const { rows } = await db.query<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM gym_memberships WHERE gym_id = ? AND role = 'admin' AND status = 'active'",
      [gymId],
    );
    if (Number(rows[0].cnt) <= 1) {
      return next.remove ? 'Cannot revoke the last admin in this gym.' : 'Cannot demote the last admin in this gym.';
    }
  }
  return null;
}

/** Grant access for a staff row and store the link. Returns what the API reports as `access`. */
async function grantForStaff(
  req: Request,
  staffRow: { id: number; gym_id: string; email: string; first_name: string; last_name: string; profile: string },
): Promise<{ status: GrantStatus | 'error'; error?: string }> {
  const role = roleForProfile(staffRow.profile)!;
  try {
    const result = await grantAccess(req, {
      gymId: staffRow.gym_id,
      email: staffRow.email,
      role,
      name: `${staffRow.first_name} ${staffRow.last_name}`,
    });
    await db.query('UPDATE staff SET gym_membership_id = ? WHERE id = ?', [result.membershipId, staffRow.id]);
    return { status: result.status };
  } catch (err: any) {
    // The staff row is already saved — surface the failure so the admin can retry
    // from the App access section instead of losing the HR record.
    return { status: 'error', error: err instanceof AccessError ? err.message : (err?.message ?? 'Unknown error') };
  }
}

/**
 * #440: resolve a staff member's center assignment for creation. Mirrors
 * members.ts's resolveMemberCenters, except a staff member is allowed zero
 * centers (an empty `center_ids` array, or none supplied for a multi-center
 * gym, leaves them unassigned rather than erroring) — unlike members, no
 * access-control path depends on a staff member having a center.
 */
async function resolveStaffCenters(
  gymId: string,
  centerIds: unknown,
  defaultCenterId: unknown,
): Promise<{ ids: number[]; defaultId: number | null } | { error: string }> {
  if (Array.isArray(centerIds)) {
    if (centerIds.length === 0) return { ids: [], defaultId: null };
    const ids = centerIds.map((id) => Number(id));
    const defaultId = ids.length === 1 ? ids[0] : Number(defaultCenterId);
    if (!defaultId || !ids.includes(defaultId)) {
      return { error: 'default_center_id must be one of center_ids' };
    }
    const { rows } = await db.query(
      `SELECT id FROM centers WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
      [gymId, ...ids],
    );
    if (rows.length !== new Set(ids).size) return { error: 'One or more center_ids are invalid for this gym' };
    return { ids, defaultId };
  }
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM centers WHERE gym_id = ? AND deleted_at IS NULL',
    [gymId],
  );
  if (rows.length === 1) return { ids: [rows[0].id], defaultId: rows[0].id };
  return { ids: [], defaultId: null };
}

const STAFF_SELECT = `
  s.id,
  s.gym_id,
  s.gym_membership_id,
  s.first_name,
  s.last_name,
  s.email,
  s.mobile_phone,
  s.profile_photo_url,
  s.date_of_birth,
  s.national_id,
  s.profile,
  s.employment_status,
  s.current_status,
  s.hire_date,
  s.contract_end_date,
  s.termination_date,
  s.direct_manager_id,
  CONCAT(m.first_name, ' ', m.last_name) AS direct_manager_name,
  s.employee_number,
  s.company_email,
  s.company_phone,
  s.personal_phone,
  s.emergency_contact,
  s.emergency_phone,
  s.working_days,
  s.work_start_time,
  s.work_end_time,
  s.break_duration_minutes,
  s.notes,
  s.deleted_at,
  s.created_at,
  s.updated_at,
  s.created_by,
  s.updated_by,
  CASE
    WHEN s.contract_end_date IS NULL THEN NULL
    ELSE DATEDIFF(s.contract_end_date, UTC_DATE())
  END AS contract_days_remaining
`;

const STAFF_FROM = `
  FROM staff s
  LEFT JOIN staff m ON m.id = s.direct_manager_id AND m.deleted_at IS NULL
`;

const VALID_SORT: Record<string, string> = {
  name: 's.last_name, s.first_name',
  hire_date: 's.hire_date',
  contract_end_date: 's.contract_end_date',
  profile: 's.profile',
  employment_status: 's.employment_status',
  current_status: 's.current_status',
  created_at: 's.created_at',
};

staffRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);

  const joins: string[] = [];
  const where: string[] = ['s.deleted_at IS NULL', 's.gym_id = ?'];
  const params: any[] = [gymId];

  if (req.query.center_id) {
    joins.push('JOIN staff_centers sc ON sc.staff_id = s.id AND sc.center_id = ? AND sc.deleted_at IS NULL');
    params.unshift(Number(req.query.center_id));
  }
  if (req.query.q) {
    const q = `%${req.query.q}%`;
    where.push('(s.first_name LIKE ? OR s.last_name LIKE ? OR s.email LIKE ? OR s.employee_number LIKE ?)');
    params.push(q, q, q, q);
  }
  if (req.query.profile) { where.push('s.profile = ?'); params.push(req.query.profile); }
  if (req.query.employment_status) { where.push('s.employment_status = ?'); params.push(req.query.employment_status); }
  if (req.query.current_status) { where.push('s.current_status = ?'); params.push(req.query.current_status); }

  const sortCol = VALID_SORT[req.query.sort as string] ?? 's.last_name, s.first_name';
  const sortDir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

  const { rows } = await db.query(
    `SELECT ${STAFF_SELECT} ${STAFF_FROM} ${joins.join(' ')} WHERE ${where.join(' AND ')} ORDER BY ${sortCol} ${sortDir}`,
    params,
  );
  res.json(rows);
});

staffRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `SELECT ${STAFF_SELECT} ${STAFF_FROM} WHERE s.id = ? AND s.gym_id = ? AND s.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Staff member not found' });
  res.json(rows[0]);
});

staffRouter.get('/:id/clerk-status', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query<any>(
    'SELECT gym_membership_id FROM staff WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Staff member not found' });

  const { gym_membership_id } = rows[0];
  if (!gym_membership_id) return res.json({ status: 'not_enrolled', userId: null });

  const { rows: memberships } = await db.query<any>(
    'SELECT user_id, status FROM gym_memberships WHERE id = ?',
    [gym_membership_id],
  );
  if (!memberships[0]) return res.json({ status: 'not_enrolled', userId: null });

  const { user_id, status } = memberships[0];
  if (status === 'invited' || String(user_id).startsWith('invited_')) {
    return res.json({ status: 'invited', userId: null });
  }

  try {
    const user = await clerkClient.users.getUser(user_id);
    const clerkStatus = user.banned || user.locked ? 'suspended' : 'active';
    return res.json({ status: clerkStatus, userId: user_id });
  } catch (err: any) {
    if (err.status === 404) return res.json({ status: 'error', userId: user_id });
    next(err);
  }
});

staffRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId, gymMembershipId } = getTenantContext(req);
  const {
    first_name, last_name, email, mobile_phone, profile_photo_url,
    date_of_birth, national_id, profile, employment_status, current_status,
    hire_date, contract_end_date, termination_date,
    center_ids, default_center_id, direct_manager_id, employee_number,
    company_email, company_phone, personal_phone, emergency_contact, emergency_phone,
    working_days, work_start_time, work_end_time, break_duration_minutes, notes,
  } = req.body;

  if (!first_name || !last_name || !email || !profile || !hire_date) {
    return res.status(400).json({ error: 'first_name, last_name, email, profile, and hire_date are required' });
  }
  if (!roleForProfile(profile)) {
    return res.status(400).json({ error: `profile must be one of: ${STAFF_PROFILES.join(', ')}` });
  }

  const centers = await resolveStaffCenters(gymId, center_ids, default_center_id);
  if ('error' in centers) return res.status(400).json({ error: centers.error });

  try {
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO staff (
          gym_id, first_name, last_name, email, mobile_phone, profile_photo_url,
          date_of_birth, national_id, profile, employment_status, current_status,
          hire_date, contract_end_date, termination_date,
          direct_manager_id, employee_number,
          company_email, company_phone, personal_phone, emergency_contact, emergency_phone,
          working_days, work_start_time, work_end_time, break_duration_minutes, notes,
          created_by, updated_by, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()
        )`,
        [
          gymId, first_name, last_name, email, mobile_phone ?? null, profile_photo_url ?? null,
          date_of_birth ?? null, national_id ?? null, profile,
          employment_status ?? 'active', current_status ?? 'available',
          hire_date, contract_end_date ?? null, termination_date ?? null,
          direct_manager_id ?? null, employee_number ?? null,
          company_email ?? null, company_phone ?? null, personal_phone ?? null,
          emergency_contact ?? null, emergency_phone ?? null,
          working_days ?? null, work_start_time ?? null, work_end_time ?? null,
          break_duration_minutes ?? null, notes ?? null,
          userId ?? null, userId ?? null,
        ],
      );
      for (const centerId of centers.ids) {
        await tx.query(
          `INSERT INTO staff_centers (gym_id, staff_id, center_id, is_default, assigned_at, assigned_by_membership_id)
           VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
          [gymId, insertId, centerId, centerId === centers.defaultId, gymMembershipId],
        );
      }
      return insertId;
    });

    // Access is granted only for employees who are active today; an inactive
    // hire gets a login when they are (re)activated / invited from the form.
    const access = (employment_status ?? 'active') === 'active'
      ? await grantForStaff(req, { id: insertId, gym_id: gymId, email, first_name, last_name, profile })
      : { status: 'not_enrolled' as const };

    const { rows } = await db.query(
      `SELECT ${STAFF_SELECT} ${STAFF_FROM} WHERE s.id = ?`,
      [insertId],
    );
    const created = rows[0];

    recordAudit(req, {
      action: 'create',
      entityType: 'staff',
      entityId: insertId,
      entityName: `${first_name} ${last_name}`,
      next: created,
    });

    res.status(201).json({ ...created, access });
  } catch (err: any) {
    next(err);
  }
});

staffRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId } = getTenantContext(req);

  const prev = await loadStaff(req.params.id, gymId);
  if (!prev) return res.status(404).json({ error: 'Staff member not found' });

  const {
    first_name, last_name, email, mobile_phone, profile_photo_url,
    date_of_birth, national_id, profile, employment_status, current_status,
    hire_date, contract_end_date, termination_date,
    direct_manager_id, employee_number,
    company_email, company_phone, personal_phone, emergency_contact, emergency_phone,
    working_days, work_start_time, work_end_time, break_duration_minutes, notes,
  } = req.body;

  if (profile !== undefined && !roleForProfile(profile)) {
    return res.status(400).json({ error: `profile must be one of: ${STAFF_PROFILES.join(', ')}` });
  }

  const nextProfile = profile ?? prev.profile;
  const nextRole = roleForProfile(nextProfile);
  const nextName = `${first_name ?? prev.first_name} ${last_name ?? prev.last_name}`;
  const nextEmail = String(email ?? prev.email).trim().toLowerCase();

  // A linked login follows the HR record: profile change → role change (guarded
  // like the old Team role edit), name change → gm.name, and a changed email on
  // a still-pending invite re-issues the invitation to the new address.
  const membership = await linkedMembership(prev);
  if (membership && nextRole && nextRole !== membership.role) {
    const blocked = await assertMembershipChange(req, membership, { role: nextRole });
    if (blocked) return res.status(400).json({ error: blocked });
  }

  try {
    await db.query(
      `UPDATE staff SET
        first_name = ?, last_name = ?, email = ?, mobile_phone = ?, profile_photo_url = ?,
        date_of_birth = ?, national_id = ?, profile = ?, employment_status = ?, current_status = ?,
        hire_date = ?, contract_end_date = ?, termination_date = ?,
        direct_manager_id = ?, employee_number = ?,
        company_email = ?, company_phone = ?, personal_phone = ?, emergency_contact = ?, emergency_phone = ?,
        working_days = ?, work_start_time = ?, work_end_time = ?, break_duration_minutes = ?, notes = ?,
        updated_by = ?, updated_at = UTC_TIMESTAMP()
      WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        first_name ?? prev.first_name, last_name ?? prev.last_name,
        email ?? prev.email, mobile_phone ?? null, profile_photo_url ?? null,
        date_of_birth ?? null, national_id ?? null,
        nextProfile, employment_status ?? prev.employment_status,
        current_status ?? prev.current_status,
        hire_date ?? prev.hire_date, contract_end_date ?? null, termination_date ?? null,
        direct_manager_id ?? null, employee_number ?? null,
        company_email ?? null, company_phone ?? null, personal_phone ?? null,
        emergency_contact ?? null, emergency_phone ?? null,
        working_days ?? null, work_start_time ?? null, work_end_time ?? null,
        break_duration_minutes ?? null, notes ?? null,
        userId ?? null,
        req.params.id, gymId,
      ],
    );

    if (membership) {
      const emailChanged = isPendingInvite(membership) && nextEmail !== String(prev.email).trim().toLowerCase();
      if (emailChanged) {
        await revokeAccess(req, membership, { deleteClerkUser: false });
        await grantForStaff(req, { ...prev, id: prev.id, email: nextEmail, first_name: first_name ?? prev.first_name, last_name: last_name ?? prev.last_name, profile: nextProfile });
      } else if (nextRole !== membership.role || nextName !== membership.name) {
        await db.query('UPDATE gym_memberships SET role = ?, name = ? WHERE id = ?', [nextRole, nextName, membership.id]);
        if (nextRole !== membership.role) {
          recordAudit(req, { action: 'change_role', entityType: 'gym_user', entityId: String(membership.id), previous: { role: membership.role }, next: { role: nextRole } });
        }
      }
    }

    const { rows } = await db.query(
      `SELECT ${STAFF_SELECT} ${STAFF_FROM} WHERE s.id = ?`,
      [req.params.id],
    );
    const updated = rows[0];

    recordAudit(req, {
      action: 'update',
      entityType: 'staff',
      entityId: Number(req.params.id),
      entityName: `${updated.first_name} ${updated.last_name}`,
      previous: prev,
      next: updated,
    });

    res.json(updated);
  } catch (err: any) {
    accessErrorToResponse(err, res, next);
  }
});

staffRouter.patch('/:id/deactivate', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId } = getTenantContext(req);
  const staffRow = await loadStaff(req.params.id, gymId);
  if (!staffRow) return res.status(404).json({ error: 'Staff member not found' });

  try {
    // Deactivating an employee removes their login (a pending invite is revoked)
    // but keeps the Clerk account — re-activation just needs a fresh invitation.
    const membership = await linkedMembership(staffRow);
    if (membership) {
      const blocked = await assertMembershipChange(req, membership, { remove: true });
      if (blocked) return res.status(400).json({ error: blocked });
      await revokeAccess(req, membership, { deleteClerkUser: false });
    }

    await db.query(
      `UPDATE staff SET employment_status = 'inactive', gym_membership_id = NULL, updated_by = ?, updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [userId ?? null, req.params.id, gymId],
    );

    const { rows } = await db.query(
      `SELECT ${STAFF_SELECT} ${STAFF_FROM} WHERE s.id = ?`,
      [req.params.id],
    );
    recordAudit(req, {
      action: 'deactivate',
      entityType: 'staff',
      entityId: Number(req.params.id),
      entityName: `${rows[0].first_name} ${rows[0].last_name}`,
    });
    res.json(rows[0]);
  } catch (err) {
    accessErrorToResponse(err, res, next);
  }
});

staffRouter.post('/:id/duplicate', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId, gymMembershipId } = getTenantContext(req);

  const { rows } = await db.query(
    'SELECT * FROM staff WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Staff member not found' });
  const src = rows[0];

  try {
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO staff (
          gym_id, first_name, last_name, email, mobile_phone,
          date_of_birth, national_id, profile, employment_status, current_status,
          hire_date, contract_end_date, termination_date,
          direct_manager_id,
          company_email, company_phone, personal_phone, emergency_contact, emergency_phone,
          working_days, work_start_time, work_end_time, break_duration_minutes, notes,
          created_by, updated_by, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()
        )`,
        [
          gymId,
          `${src.first_name} (copy)`, src.last_name, src.email, src.mobile_phone,
          src.date_of_birth, src.national_id, src.profile, 'active', 'available',
          src.hire_date, src.contract_end_date, null,
          src.direct_manager_id,
          src.company_email, src.company_phone, src.personal_phone,
          src.emergency_contact, src.emergency_phone,
          src.working_days, src.work_start_time, src.work_end_time,
          src.break_duration_minutes, src.notes,
          userId ?? null, userId ?? null,
        ],
      );

      const { rows: srcCenters } = await tx.query<{ center_id: number; is_default: boolean }>(
        'SELECT center_id, is_default FROM staff_centers WHERE staff_id = ? AND gym_id = ? AND deleted_at IS NULL',
        [req.params.id, gymId],
      );
      for (const sc of srcCenters) {
        await tx.query(
          `INSERT INTO staff_centers (gym_id, staff_id, center_id, is_default, assigned_at, assigned_by_membership_id)
           VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
          [gymId, insertId, sc.center_id, sc.is_default, gymMembershipId],
        );
      }
      return insertId;
    });

    const { rows: duped } = await db.query(
      `SELECT ${STAFF_SELECT} ${STAFF_FROM} WHERE s.id = ?`,
      [insertId],
    );
    res.status(201).json(duped[0]);
  } catch (err: any) {
    next(err);
  }
});

staffRouter.delete('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId, userId } = getTenantContext(req);
  const staffRow = await loadStaff(req.params.id, gymId);
  if (!staffRow) return res.status(404).json({ error: 'Staff member not found' });

  try {
    // Same semantics the Team page's Remove had: the Clerk account goes too when
    // this gym was the user's last one, and that must succeed before we soft-delete.
    const membership = await linkedMembership(staffRow);
    if (membership) {
      const blocked = await assertMembershipChange(req, membership, { remove: true });
      if (blocked) return res.status(400).json({ error: blocked });
      await revokeAccess(req, membership, { deleteClerkUser: true });
    }

    await db.query(
      `UPDATE staff SET deleted_at = UTC_TIMESTAMP(), gym_membership_id = NULL, updated_by = ?, updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [userId ?? null, req.params.id, gymId],
    );

    recordAudit(req, {
      action: 'delete',
      entityType: 'staff',
      entityId: Number(req.params.id),
    });
    res.status(204).send();
  } catch (err) {
    accessErrorToResponse(err, res, next);
  }
});

/**
 * POST /staff/:id/access — grant, or re-send, app access for a staff member.
 * Idempotent: not enrolled → grant/invite; pending invite → resend; active → no-op.
 * This is the retry path when the automatic grant on creation failed.
 */
staffRouter.post('/:id/access', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const staffRow = await loadStaff(req.params.id, gymId);
  if (!staffRow) return res.status(404).json({ error: 'Staff member not found' });
  if (!roleForProfile(staffRow.profile)) {
    return res.status(400).json({ error: `profile must be one of: ${STAFF_PROFILES.join(', ')}` });
  }

  try {
    const membership = await linkedMembership(staffRow);
    if (membership && isPendingInvite(membership)) {
      await resendInvitation(req, membership);
      return res.json({ status: 'reinvited' });
    }
    if (membership) return res.json({ status: 'already_granted' });

    const access = await grantForStaff(req, staffRow);
    if (access.status === 'error') return res.status(502).json({ error: access.error });
    res.status(201).json(access);
  } catch (err) {
    accessErrorToResponse(err, res, next);
  }
});

/**
 * DELETE /staff/:id/access — revoke app access, leaving the HR record untouched.
 * The Clerk account is kept, so access can be granted again later.
 */
staffRouter.delete('/:id/access', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const staffRow = await loadStaff(req.params.id, gymId);
  if (!staffRow) return res.status(404).json({ error: 'Staff member not found' });

  try {
    const membership = await linkedMembership(staffRow);
    if (!membership) return res.status(204).send();

    const blocked = await assertMembershipChange(req, membership, { remove: true });
    if (blocked) return res.status(400).json({ error: blocked });

    await revokeAccess(req, membership, { deleteClerkUser: false });
    await db.query('UPDATE staff SET gym_membership_id = NULL WHERE id = ?', [staffRow.id]);
    res.status(204).send();
  } catch (err) {
    accessErrorToResponse(err, res, next);
  }
});

/**
 * POST /staff/link — called by the admin app on an invitee's first sign-in
 * (mounted before tenantContext: no membership row exists yet). Materializes
 * the gym_memberships row from the Clerk `gym_invite` metadata.
 */
staffLinkRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const row = await linkGymInvite(userId);
    if (!row) return res.status(404).json({ error: 'No pending staff invitation found.' });
    res.json(row);
  } catch (err) { next(err); }
});
