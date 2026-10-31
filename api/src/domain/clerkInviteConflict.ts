// #2183 — when Clerk refuses an invitation because "an invitation or account already
// exists", the local member row may be out of step with Clerk (invitation_id NULL while
// Clerk holds a pending invitation). This module decides what Clerk's own answer means;
// the status is never inferred from the error message alone.
//
// Pure — no DB, no HTTP.

export interface ClerkInvitationLike {
  id: string;
  emailAddress?: string | null;
  status?: string | null;
}

export interface ClerkUserLike {
  id: string;
  emailAddresses?: Array<{ emailAddress?: string | null }> | null;
}

export type InviteConflictResolution =
  | { kind: 'pending_invitation'; invitationId: string }
  | { kind: 'account_exists'; userId: string }
  | { kind: 'unknown' };

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** Clerk list endpoints answer `{ data }` in current SDKs and a bare array in older ones. */
export function listItems<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const data = (res as { data?: unknown } | null | undefined)?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

/**
 * An existing account outranks a pending invitation (the invitation was consumed or is
 * moot); neither match leaves the status untouched.
 */
export function resolveInviteConflict(
  email: string,
  invitations: ClerkInvitationLike[],
  users: ClerkUserLike[],
): InviteConflictResolution {
  const target = norm(email);
  const user = users.find((u) => (u.emailAddresses ?? []).some((e) => norm(e.emailAddress) === target));
  if (user) return { kind: 'account_exists', userId: user.id };
  const invitation = invitations.find(
    (i) => norm(i.emailAddress) === target && (i.status == null || i.status === 'pending'),
  );
  if (invitation) return { kind: 'pending_invitation', invitationId: invitation.id };
  return { kind: 'unknown' };
}
