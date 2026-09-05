import { Router } from 'express';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { getTenantContext, requireRole, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { gymFetchOne, handleDupEntry } from '../infra/db-helpers';

/**
 * #59: resolve a member's center assignment for creation. Mirrors
 * resolveCenterId's fallback (explicit ids > the gym's sole active center),
 * but returns the full set + default since a member needs >= 1 center.
 */
async function resolveMemberCenters(
  gymId: string,
  centerIds: unknown,
  defaultCenterId: unknown,
): Promise<{ ids: number[]; defaultId: number } | { error: string }> {
  if (Array.isArray(centerIds) && centerIds.length > 0) {
    const ids = centerIds.map((id) => Number(id));
    const defaultId = Number(defaultCenterId);
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
  return { error: 'default_center_id is required — this gym has multiple centers' };
}

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

export const membersRouter = Router();

membersRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const centerId = req.query.centerId ? Number(req.query.centerId) : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : null;
  const paymentStatusFilter = typeof req.query.payment_status === 'string' ? req.query.payment_status : null;
  const enrollmentStatusFilter = typeof req.query.enrollment_status === 'string' ? req.query.enrollment_status : null;
  const joins: string[] = [];
  const where: string[] = ['m.deleted_at IS NULL', 'm.gym_id = ?'];
  const params: any[] = [gymId];
  if (centerId) {
    joins.push('JOIN member_centers mc ON mc.member_id = m.id AND mc.center_id = ? AND mc.deleted_at IS NULL');
    params.unshift(centerId);
  }
  if (q) {
    where.push('(m.name LIKE ? OR m.email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  // enrollment_status filter: applied as HAVING since it's a subquery alias
  const having: string[] = [];
  if (paymentStatusFilter) {
    having.push('payment_status = ?');
    params.push(paymentStatusFilter);
  }
  if (enrollmentStatusFilter) {
    having.push('enrollment_status = ?');
    params.push(enrollmentStatusFilter);
  }
  const limitClause = q ? 'LIMIT 20' : '';
  const havingClause = having.length ? `HAVING ${having.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT m.*, m.membership_plan_id AS fare_id, p.name AS fare_name,
            CASE
              WHEN m.clerk_user_id IS NOT NULL THEN 'active'
              WHEN m.invitation_id IS NOT NULL THEN 'invited'
              ELSE 'not_enrolled'
            END AS account_status,
            (SELECT um.status
             FROM user_memberships um
             WHERE um.member_id = m.id AND um.gym_id = m.gym_id
             ORDER BY um.created_at DESC, um.id DESC LIMIT 1) AS enrollment_status,
            (SELECT pr.status
             FROM payment_requests pr
             WHERE pr.member_id = m.id AND pr.gym_id = m.gym_id
             ORDER BY pr.created_at DESC LIMIT 1) AS payment_status
     FROM members m
     LEFT JOIN membership_plans p ON p.id = m.membership_plan_id
     ${joins.join(' ')}
     WHERE ${where.join(' AND ')}
     ${havingClause}
     ORDER BY m.name ASC
     ${limitClause}`,
    params,
  );
  res.json(rows);
});

membersRouter.get('/count', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT COUNT(*) AS count FROM members WHERE deleted_at IS NULL AND gym_id = ?',
    [gymId],
  );
  res.json({ count: Number(rows[0].count) });
});

membersRouter.get('/deleted', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM members WHERE deleted_at IS NOT NULL AND gym_id = ? ORDER BY deleted_at DESC',
    [gymId],
  );
  res.json(rows);
});

membersRouter.post('/:id/restore', requireModuleWrite('MEMBERS'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'UPDATE members SET deleted_at = NULL WHERE id = ? AND gym_id = ? AND deleted_at IS NOT NULL',
    [req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Member not found or not deleted' });
  const { rows } = await db.query('SELECT * FROM members WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
  res.json(rows[0]);
});

membersRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    `SELECT m.*,
            cb.name AS created_by_name,
            mb.name AS modified_by_name
     FROM members m
     LEFT JOIN gym_memberships cb ON cb.id = m.created_by
     LEFT JOIN gym_memberships mb ON mb.id = m.modified_by
     WHERE m.id = ? AND m.gym_id = ? AND m.deleted_at IS NULL`,
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Member not found' });
  res.json(rows[0]);
});

membersRouter.get('/:id/clerk-status', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query<any>(
    'SELECT clerk_user_id, invitation_id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [req.params.id, gymId],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Member not found' });

  const { clerk_user_id, invitation_id } = rows[0];

  if (!clerk_user_id) {
    return res.json({ status: invitation_id ? 'invited' : 'not_enrolled', userId: null });
  }

  try {
    const user = await clerkClient.users.getUser(clerk_user_id);
    const status = user.banned || user.locked ? 'suspended' : 'active';
    return res.json({ status, userId: clerk_user_id });
  } catch (err: any) {
    if (err.status === 404) return res.json({ status: 'error', userId: clerk_user_id });
    next(err);
  }
});

membersRouter.post('/', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  const { name, email, phone, fare_id, center_ids, default_center_id } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  const centers = await resolveMemberCenters(gymId, center_ids, default_center_id);
  if ('error' in centers) return res.status(400).json({ error: centers.error });

  try {
    const insertId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        'INSERT INTO members (name, email, phone, membership_plan_id, gym_id, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        [name, email, phone ?? null, fare_id ?? null, gymId, gymMembershipId ?? null],
      );
      for (const centerId of centers.ids) {
        await tx.query(
          `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at, assigned_by_membership_id)
           VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
          [gymId, insertId, centerId, centerId === centers.defaultId, gymMembershipId],
        );
      }
      return insertId;
    });
    const { rows } = await db.query('SELECT * FROM members WHERE id = ?', [insertId]);
    recordAudit(req, { action: 'create', entityType: 'member', entityId: insertId, next: rows[0] });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A member with this email already exists.');
  }
});

membersRouter.put('/:id', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId, gymMembershipId } = getTenantContext(req);
  // email is intentionally excluded — Clerk sync is out of scope (#346 §5.1)
  const { name, phone, date_of_birth, gender, address, emergency_contact, notes } = req.body;
  try {
    const { rowCount } = await db.query(
      `UPDATE members SET
        name              = COALESCE(?, name),
        phone             = ?,
        date_of_birth     = ?,
        gender            = ?,
        address           = ?,
        emergency_contact = ?,
        notes             = ?,
        modified_at       = UTC_TIMESTAMP(),
        modified_by       = ?
       WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
      [
        name ?? null,
        phone ?? null,
        date_of_birth ?? null,
        gender ?? null,
        address ?? null,
        emergency_contact ?? null,
        notes ?? null,
        gymMembershipId ?? null,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Member not found' });
    const { rows } = await db.query(
      'SELECT * FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    recordAudit(req, { action: 'update', entityType: 'member', entityId: req.params.id, next: rows[0] });
    res.json(rows[0]);
  } catch (err: any) {
    handleDupEntry(err, res, next, 'A member with this email already exists.');
  }
});

membersRouter.post('/:id/invite', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberAppUrl = process.env.CORDEL_FITNESS_MEMBERS_URL ?? '';
  try {
    const { rows } = await db.query(
      'SELECT email, clerk_user_id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });
    if (rows[0].clerk_user_id) return res.status(409).json({ error: 'This member already has portal access.' });

    const invitation = await clerkClient.invitations.createInvitation({
      emailAddress: rows[0].email,
      redirectUrl: `${memberAppUrl}/en/link?gym_id=${gymId}`,
    });
    await db.query('UPDATE members SET invitation_id = ? WHERE id = ?', [invitation.id, req.params.id]);
    recordAudit(req, { action: 'invite', entityType: 'member', entityId: req.params.id, next: { email: rows[0].email } });
    res.json({ ok: true });
  } catch (err: any) {
    // Clerk returns 422 when an invitation for this email already exists/user already exists
    if (err.status === 422) return res.status(409).json({ error: 'An invitation or account already exists for this email.' });
    next(err);
  }
});

// POST /:id/reinvite — resend a still-pending invitation for member-portal access
membersRouter.post('/:id/reinvite', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const memberAppUrl = process.env.CORDEL_FITNESS_MEMBERS_URL ?? '';
  try {
    const { rows } = await db.query(
      'SELECT email, clerk_user_id, invitation_id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });
    if (rows[0].clerk_user_id) return res.status(400).json({ error: 'This member has already linked their account.' });
    if (!rows[0].invitation_id) return res.status(400).json({ error: 'No pending invitation for this member. Use Invite instead.' });

    const invitation = await clerkClient.invitations.createInvitation({
      emailAddress: rows[0].email,
      redirectUrl: `${memberAppUrl}/en/link?gym_id=${gymId}`,
    });
    await db.query('UPDATE members SET invitation_id = ? WHERE id = ?', [invitation.id, req.params.id]);
    recordAudit(req, { action: 'reinvite', entityType: 'member', entityId: req.params.id, next: { email: rows[0].email } });
    res.json({ ok: true });
  } catch (err: any) {
    if (err.status === 422) return res.status(409).json({ error: 'An invitation is already pending for this email.' });
    next(err);
  }
});

// POST /:id/revoke-invite — cancel a pending portal invitation without removing the member
membersRouter.post('/:id/revoke-invite', requireModuleWrite('MEMBERS'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      'SELECT clerk_user_id, invitation_id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });
    if (rows[0].clerk_user_id) return res.status(400).json({ error: 'This member has already linked their account; nothing to revoke.' });
    if (!rows[0].invitation_id) return res.status(400).json({ error: 'No pending invitation for this member.' });

    try {
      await clerkClient.invitations.revokeInvitation(rows[0].invitation_id);
    } catch (err: any) {
      console.error('Failed to revoke member invitation:', { memberId: req.params.id, error: err.message });
      return res.status(502).json({ error: 'Failed to revoke invitation in Clerk.' });
    }

    await db.query('UPDATE members SET invitation_id = NULL WHERE id = ?', [req.params.id]);
    recordAudit(req, { action: 'revoke_invite', entityType: 'member', entityId: req.params.id });
    res.status(204).send();
  } catch (err) { next(err); }
});

membersRouter.delete('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  try {
    const { rows } = await db.query(
      'SELECT clerk_user_id, invitation_id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Member not found' });

    // If a portal invitation is still pending (never accepted), revoke it so the
    // invite link can't be used to resurrect access after the member is removed.
    if (!rows[0].clerk_user_id && rows[0].invitation_id) {
      try {
        await clerkClient.invitations.revokeInvitation(rows[0].invitation_id);
      } catch (err: any) {
        console.error('Failed to revoke member invitation on delete:', { memberId: req.params.id, error: err.message });
        // Continue with the soft-delete even if revoke fails.
      }
    }

    const { rowCount } = await db.query(
      'UPDATE members SET deleted_at = UTC_TIMESTAMP(), invitation_id = NULL WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [req.params.id, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Member not found' });
    recordAudit(req, { action: 'soft_delete', entityType: 'member', entityId: req.params.id });
    res.status(204).send();
  } catch (err) { next(err); }
});
