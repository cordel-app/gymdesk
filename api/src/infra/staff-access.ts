import { createClerkClient } from '@clerk/backend';
import { db } from './db';
import { recordAudit } from './audit';
import { AppRole } from './permissions';

/**
 * #592: App access for Staff records — the Clerk invite / grant / revoke
 * mechanics behind `staff.gym_membership_id`. Moved verbatim (in behavior)
 * from the removed Team router (`gym-users.ts`, #53): Staff is now the only
 * place an admin manages who can sign in to the admin app, and every Staff
 * record owns at most one `gym_memberships` row in its gym.
 *
 * Grant flow:
 *   - Email Clerk already knows → INSERT/UPDATE gym_memberships (status active).
 *   - Email Clerk doesn't know → Clerk invitation carrying `gym_invite`
 *     metadata + an `invited_<ts>` placeholder row.
 *   - On the invitee's first sign-in `linkGymInvite` (via POST /staff/link or
 *     the Clerk `user.created` webhook) swaps the placeholder's user_id for the
 *     real Clerk id. `staff.gym_membership_id` already points at that row, so
 *     the Staff record needs no further update.
 */

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

/** Thrown for expected failures the router should map straight to an HTTP status. */
export class AccessError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface MembershipRow {
  id: number;
  user_id: string;
  gym_id: string;
  role: AppRole;
  status: 'invited' | 'active';
  email: string | null;
  name: string | null;
  invitation_id: string | null;
}

export type GrantStatus = 'granted' | 'already_granted' | 'invited';

/**
 * #594: one email is never both member and staff of the same gym. A staff
 * member signs in with their work account; if the same person is also a
 * member, that membership lives on a separate personal account. Both flows
 * write the single `gym_memberships` row per (user, gym), so a collision would
 * silently flip the role and break whichever app lost — refuse it instead.
 */
export const MEMBER_EMAIL_CONFLICT =
  "This email is registered as a member of this gym. Use the staff member's work email for their login; membership stays on their personal email.";
export const STAFF_EMAIL_CONFLICT =
  'This email is a staff login for this gym. Use a personal email for the membership.';

/**
 * Staff side of the #594 guard. Throws 409 when the email belongs to an active
 * member of the gym, or when the Clerk account behind it already holds a
 * `member` row there. Returns the resolved Clerk user (or undefined) so the
 * caller can hand it to `grantAccess` and skip a second lookup.
 */
export async function assertNotMemberEmail(gymId: string, rawEmail: string): Promise<any | undefined> {
  const email = rawEmail.trim().toLowerCase();
  const { rows: memberRows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE gym_id = ? AND LOWER(email) = ? AND deleted_at IS NULL LIMIT 1',
    [gymId, email],
  );
  if (memberRows[0]) throw new AccessError(409, MEMBER_EMAIL_CONFLICT);

  const clerkUser = await lookupClerkUser(email);
  if (clerkUser) {
    const { rows } = await db.query<{ role: string }>(
      'SELECT role FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
      [clerkUser.id, gymId],
    );
    if (rows[0]?.role === 'member') throw new AccessError(409, MEMBER_EMAIL_CONFLICT);
  }
  return clerkUser;
}

/**
 * Member side of the #594 guard: true when the email is already a staff login
 * in this gym — a Staff record with a linked membership, or a pending staff
 * invitation placeholder. (A login with no Staff record, e.g. the gym owner,
 * is caught by `/me/link`'s user-id check instead.)
 */
export async function isStaffLoginEmail(gymId: string, rawEmail: string): Promise<boolean> {
  const email = rawEmail.trim().toLowerCase();
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT s.id FROM staff s
         JOIN gym_memberships gm ON gm.id = s.gym_membership_id
        WHERE s.gym_id = ? AND LOWER(s.email) = ? AND s.deleted_at IS NULL
       UNION ALL
       SELECT gm.id FROM gym_memberships gm
        WHERE gm.gym_id = ? AND gm.role != 'member' AND LOWER(gm.email) = ?
     ) x`,
    [gymId, email, gymId, email],
  );
  return Number(rows[0].n) > 0;
}

async function lookupClerkUser(email: string): Promise<any | undefined> {
  try {
    const { data } = await clerkClient.users.getUserList({ emailAddress: [email], limit: 1 });
    return data[0];
  } catch (err: any) {
    console.error('Clerk getUserList error:', { message: err.message, status: err.status, errors: err.errors });
    throw mapClerkError(err, 'Failed to lookup user');
  }
}

export async function getMembership(id: number): Promise<MembershipRow | null> {
  const { rows } = await db.query<MembershipRow>('SELECT * FROM gym_memberships WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export function isPendingInvite(m: Pick<MembershipRow, 'status' | 'user_id'>): boolean {
  return m.status === 'invited' || String(m.user_id).startsWith('invited_');
}

function invitationRedirect(): { redirectUrl: string } | Record<string, never> {
  const adminUrl = process.env.CORDEL_FITNESS_ADMIN_URL ?? '';
  return adminUrl ? { redirectUrl: `${adminUrl}/en/sign-up` } : {};
}

async function createInvitation(email: string, gymId: string, role: AppRole) {
  return clerkClient.invitations.createInvitation({
    emailAddress: email,
    publicMetadata: { gym_invite: { gym_id: gymId, role } },
    ...invitationRedirect(),
  });
}

/** Translate Clerk SDK errors into the statuses the old Team router used. */
function mapClerkError(err: any, fallback: string): AccessError {
  const msg: string = err?.errors?.[0]?.message || err?.message || '';
  if (err?.status === 401) return new AccessError(500, 'Clerk authentication failed. Check CLERK_SECRET_KEY.');
  if (err?.status === 429 || msg.includes('rate_limited')) return new AccessError(429, 'Too many requests. Please try again later.');
  if (msg.includes('invalid_email')) return new AccessError(400, 'Invalid email address format.');
  if (err?.status === 400) return new AccessError(400, 'Invalid request: ' + msg);
  return new AccessError(500, `${fallback}: ${msg || 'Unknown error'}`);
}

/**
 * Grant (or re-grant) access for one email in one gym. Idempotent: an existing
 * active membership just has its role/name synced; an existing pending invite
 * is returned as-is (use `resendInvitation` to re-issue it).
 */
export async function grantAccess(
  req: any,
  opts: { gymId: string; email: string; role: AppRole; name: string; clerkUser?: any },
): Promise<{ status: GrantStatus; membershipId: number }> {
  const { gymId, role, name } = opts;
  const email = opts.email.trim().toLowerCase();

  // `clerkUser` is the user already resolved by assertNotMemberEmail (#594);
  // callers that skipped that check get it looked up (and guarded) here.
  const existing = 'clerkUser' in opts ? opts.clerkUser : await assertNotMemberEmail(gymId, email);

  if (existing) {
    const { rows } = await db.query<MembershipRow>(
      'SELECT * FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
      [existing.id, gymId],
    );
    const row = rows[0];
    if (row?.role === 'member') throw new AccessError(409, MEMBER_EMAIL_CONFLICT);
    if (row) {
      if (row.role === role && row.name === name) return { status: 'already_granted', membershipId: row.id };
      // COALESCE so a blank name never clobbers one saved earlier (#504).
      await db.query('UPDATE gym_memberships SET role = ?, name = COALESCE(?, name) WHERE id = ?', [role, name || null, row.id]);
      recordAudit(req, { action: 'change_role', entityType: 'gym_user', entityId: String(row.id), previous: { role: row.role }, next: { role } });
      return { status: 'granted', membershipId: row.id };
    }
    // Persist the name on insert (#504: this path used to drop it, leaving the
    // row findable only by its raw Clerk user_id).
    const { insertId } = await db.query(
      'INSERT INTO gym_memberships (user_id, gym_id, role, status, name) VALUES (?, ?, ?, ?, ?)',
      [existing.id, gymId, role, 'active', name || null],
    );
    recordAudit(req, { action: 'grant', entityType: 'gym_user', entityId: String(insertId), next: { email, role, name } });
    return { status: 'granted', membershipId: insertId };
  }

  // Already invited to this gym → reuse the placeholder rather than 409ing:
  // a Staff record may be (re)created for an email whose invite is still open.
  const { rows: invitedRows } = await db.query<MembershipRow>(
    'SELECT * FROM gym_memberships WHERE LOWER(email) = ? AND gym_id = ? AND status = ?',
    [email, gymId, 'invited'],
  );
  if (invitedRows[0]) {
    await db.query('UPDATE gym_memberships SET role = ?, name = COALESCE(?, name) WHERE id = ?', [role, name || null, invitedRows[0].id]);
    return { status: 'invited', membershipId: invitedRows[0].id };
  }

  let invitation: any;
  try {
    invitation = await createInvitation(email, gymId, role);
  } catch (err: any) {
    const msg: string = err?.errors?.[0]?.message || err?.message || '';
    console.error('Clerk invitations.createInvitation error:', { message: err.message, status: err.status, errors: err.errors });
    // 422 / "already pending": Clerk still has a live invitation for this email
    // (e.g. the placeholder row was removed). Treat as invited and recreate the row.
    const alreadyPending = err?.status === 422
      || (err?.status === 400 && /existing|already|pending|duplicate/.test(msg));
    if (!alreadyPending) throw mapClerkError(err, 'Failed to send invitation');
  }

  const { insertId } = await db.query(
    'INSERT INTO gym_memberships (user_id, gym_id, role, status, email, name, invitation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`invited_${Date.now()}`, gymId, role, 'invited', email, name || null, invitation?.id ?? null],
  );
  recordAudit(req, { action: 'invite', entityType: 'gym_user', entityId: email, next: { email, role } });
  return { status: 'invited', membershipId: insertId };
}

/**
 * Re-issue a pending invitation. Overwrites the stored `invitation_id` — the
 * previous one is superseded and no longer revocable, so a later revoke must
 * target *this* invitation.
 */
export async function resendInvitation(req: any, membership: MembershipRow): Promise<void> {
  if (!isPendingInvite(membership) || !membership.email) {
    throw new AccessError(400, 'Can only resend an invitation that is still pending.');
  }
  try {
    const invitation = await createInvitation(membership.email, membership.gym_id, membership.role);
    await db.query('UPDATE gym_memberships SET invitation_id = ? WHERE id = ?', [invitation.id, membership.id]);
    recordAudit(req, { action: 'reinvite', entityType: 'gym_user', entityId: String(membership.id), next: { email: membership.email } });
  } catch (err: any) {
    if (err instanceof AccessError) throw err;
    const msg: string = err?.errors?.[0]?.message || err?.message || '';
    console.error('Clerk invitation error on reinvite:', { message: err.message, status: err.status, email: membership.email });
    if (err?.status === 422 || /duplicate|pending/.test(msg)) {
      throw new AccessError(409, 'An invitation is already pending for this email.');
    }
    throw mapClerkError(err, 'Failed to send invitation');
  }
}

/**
 * Revoke access: a pending invite is revoked in Clerk (best-effort) and the row
 * deleted. For an active user the row is deleted; with `deleteClerkUser`, the
 * Clerk account is also removed when this was their last gym anywhere — and
 * that Clerk delete must succeed first, so a failure never orphans the account.
 */
export async function revokeAccess(
  req: any,
  membership: MembershipRow,
  opts: { deleteClerkUser: boolean },
): Promise<void> {
  if (isPendingInvite(membership)) {
    if (membership.invitation_id) {
      try {
        await clerkClient.invitations.revokeInvitation(membership.invitation_id);
      } catch (err: any) {
        console.error('Failed to revoke Clerk invitation:', { invitationId: membership.invitation_id, error: err.message });
      }
    }
  } else if (opts.deleteClerkUser) {
    const { rows } = await db.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM gym_memberships WHERE user_id = ? AND gym_id != ?',
      [membership.user_id, membership.gym_id],
    );
    if (Number(rows[0].cnt) === 0) {
      try {
        await clerkClient.users.deleteUser(membership.user_id);
      } catch (err: any) {
        console.error('Failed to delete Clerk user:', { userId: membership.user_id, error: err.message });
        throw new AccessError(502, 'Failed to delete user from Clerk. Access was not revoked.');
      }
    }
  }

  await db.query('DELETE FROM gym_memberships WHERE id = ?', [membership.id]);
  recordAudit(req, { action: 'remove', entityType: 'gym_user', entityId: String(membership.id), previous: { role: membership.role } });
}

/**
 * Materialize a gym_memberships row from a user's Clerk `gym_invite` metadata.
 * Shared by the admin-app self-heal (POST /staff/link) and the Clerk
 * `user.created` webhook, so activation happens whichever path fires first.
 * Idempotent: once the metadata is cleared, subsequent calls return null.
 */
export async function linkGymInvite(userId: string): Promise<any | null> {
  const clerkUser = await clerkClient.users.getUser(userId);
  const meta = (clerkUser.publicMetadata as any) ?? {};
  const gymInvite = meta.gym_invite;
  if (!gymInvite) return null;

  const { gym_id: gymId, role } = gymInvite;
  // Placeholder rows store the email lowercased at invite time.
  const userEmail = clerkUser.emailAddresses?.[0]?.emailAddress ?? (clerkUser as any).email;

  const { rows: existingInvited } = await db.query<{ id: number }>(
    'SELECT id FROM gym_memberships WHERE gym_id = ? AND role = ? AND status = ? AND LOWER(email) = LOWER(?)',
    [gymId, role, 'invited', userEmail],
  );

  if (existingInvited.length > 0) {
    // Flip the placeholder to the real user — staff.gym_membership_id keeps pointing here.
    await db.query(
      'UPDATE gym_memberships SET user_id = ?, status = ?, email = NULL WHERE id = ?',
      [userId, 'active', existingInvited[0].id],
    );
  } else {
    await db.query(
      'INSERT IGNORE INTO gym_memberships (user_id, gym_id, role, status) VALUES (?, ?, ?, ?)',
      [userId, gymId, role, 'active'],
    );
  }

  const { rows } = await db.query<any>(
    'SELECT * FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
    [userId, gymId],
  );

  await clerkClient.users.updateUserMetadata(userId, {
    publicMetadata: { ...meta, gym_invite: null },
  });

  recordAudit(
    { tenantCtx: { userId, gymId, role: 'admin' } } as any,
    { action: 'link', entityType: 'gym_user', entityId: userId, next: { gym_id: gymId, role } },
  );

  return rows[0];
}
