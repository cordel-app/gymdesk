import { db } from './db';

/**
 * #709: the single definition of "is this Clerk account still linked to
 * Gymdesk?", shared by the member delete (part 1), the Clerk `user.deleted`
 * webhook (part 2) and the superadmin Orphaned accounts screen (part 3), so
 * the three can never disagree.
 *
 * An account is LINKED when any of these hold:
 *   - it is a platform superadmin (Clerk publicMetadata.platform_role)
 *   - it has a staff gym_memberships row (any role but 'member')
 *   - it has an ACTIVE members row (clerk_user_id = id, deleted_at IS NULL)
 *
 * A member-role gym_memberships row on its own does NOT count: deleting a
 * member used to leave that row behind, which is exactly how orphans appeared.
 *
 * These queries span gyms on purpose — an account's links are platform-wide —
 * so they are the one place that does not filter by gym_id.
 */

export interface GymRef {
  gym_id: string;
  gym_name: string | null;
}

export interface AccountLinks {
  staffGyms: GymRef[];
  activeMemberGyms: GymRef[];
  deletedMemberGyms: GymRef[];
}

const EMPTY_LINKS: AccountLinks = { staffGyms: [], activeMemberGyms: [], deletedMemberGyms: [] };

/** Gymdesk links for many Clerk users at once: one query per table. */
export async function loadAccountLinks(userIds: string[]): Promise<Map<string, AccountLinks>> {
  const out = new Map<string, AccountLinks>();
  for (const id of userIds) out.set(id, { staffGyms: [], activeMemberGyms: [], deletedMemberGyms: [] });
  if (userIds.length === 0) return out;

  const marks = userIds.map(() => '?').join(',');
  const [{ rows: staff }, { rows: members }] = await Promise.all([
    db.query<{ user_id: string; gym_id: string; gym_name: string | null }>(
      `SELECT gm.user_id, gm.gym_id, g.name AS gym_name
       FROM gym_memberships gm LEFT JOIN gyms g ON g.id = gm.gym_id
       WHERE gm.user_id IN (${marks}) AND gm.role <> 'member'`,
      userIds,
    ),
    db.query<{ clerk_user_id: string; gym_id: string; gym_name: string | null; deleted_at: Date | null }>(
      `SELECT m.clerk_user_id, m.gym_id, g.name AS gym_name, m.deleted_at
       FROM members m LEFT JOIN gyms g ON g.id = m.gym_id
       WHERE m.clerk_user_id IN (${marks})`,
      userIds,
    ),
  ]);
  for (const r of staff) out.get(r.user_id)?.staffGyms.push({ gym_id: r.gym_id, gym_name: r.gym_name });
  for (const r of members) {
    const links = out.get(r.clerk_user_id);
    if (!links) continue;
    (r.deleted_at ? links.deletedMemberGyms : links.activeMemberGyms).push({ gym_id: r.gym_id, gym_name: r.gym_name });
  }
  return out;
}

export async function loadAccountLinksFor(userId: string): Promise<AccountLinks> {
  return (await loadAccountLinks([userId])).get(userId) ?? { ...EMPTY_LINKS };
}

export interface ClerkUserLike {
  publicMetadata?: Record<string, unknown> | null;
  createdAt?: number | null;
}

export type OrphanReason = 'member_deleted' | 'signup_incomplete' | 'signup_in_progress' | 'no_links';

export interface AccountStatus {
  linked: boolean;
  /** Set only when not linked. */
  reason: OrphanReason | null;
  /** False for a sign-up still within its grace period. */
  deletable: boolean;
}

/** An account younger than this that still carries sign-up metadata is mid-sign-up. */
export const SIGNUP_GRACE_MS = 24 * 60 * 60 * 1000;

export function isSuperadmin(user: ClerkUserLike): boolean {
  return (user.publicMetadata as any)?.platform_role === 'superadmin';
}

/** Pure: classify one Clerk account from its metadata and Gymdesk links. */
export function classifyAccount(user: ClerkUserLike, links: AccountLinks, now = Date.now()): AccountStatus {
  if (isSuperadmin(user) || links.staffGyms.length > 0 || links.activeMemberGyms.length > 0) {
    return { linked: true, reason: null, deletable: false };
  }
  const meta = (user.publicMetadata ?? {}) as Record<string, unknown>;
  if (meta.gym_signup || meta.gym_invite) {
    const age = user.createdAt != null ? now - user.createdAt : Infinity;
    return age < SIGNUP_GRACE_MS
      ? { linked: false, reason: 'signup_in_progress', deletable: false }
      : { linked: false, reason: 'signup_incomplete', deletable: true };
  }
  if (links.deletedMemberGyms.length > 0) return { linked: false, reason: 'member_deleted', deletable: true };
  return { linked: false, reason: 'no_links', deletable: true };
}

/**
 * Remove every Gymdesk pointer to a Clerk account that no longer exists (or is
 * about to be deleted): its gym_memberships rows go, and members rows are kept
 * but unlinked so staff can invite the person again. Idempotent.
 * FKs to gym_memberships are all ON DELETE SET NULL / CASCADE (checked for #709).
 */
export async function unlinkClerkAccount(userId: string): Promise<{ memberships: number; members: number }> {
  const { rowCount: memberships } = await db.query('DELETE FROM gym_memberships WHERE user_id = ?', [userId]);
  const { rowCount: members } = await db.query('UPDATE members SET clerk_user_id = NULL WHERE clerk_user_id = ?', [userId]);
  return { memberships: memberships ?? 0, members: members ?? 0 };
}
