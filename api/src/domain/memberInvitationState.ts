// #2680 — the Members App invitation state of a Member, reconciled with Clerk.
//
// Four states the ticket names, plus one for a Clerk lookup that failed:
//   linked              `members.clerk_user_id` is set (the one proof of a link)
//   invitation_pending  Clerk holds a pending invitation for the Member's email
//   account_exists      a Clerk account has that email but is not linked here
//   not_invited         none of the above
//   unknown             Clerk could not be asked and the row stores no invitation,
//                       so neither "not invited" nor "pending" may be claimed
//
// Clerk is the source of truth for whether an invitation is pending; the stored
// `invitation_id` is a cache of it, which `storeInvitationId` says how to correct.
// A failed lookup never writes and never reports an invitation as absent.
//
// Pure — no DB, no HTTP.

export type MembersAppInvitationState =
  | 'linked'
  | 'invitation_pending'
  | 'account_exists'
  | 'not_invited'
  | 'unknown';

export interface ClerkInvitationLookup {
  /** Ids of Clerk's pending invitations addressed to the Member's email. */
  pendingInvitationIds: string[];
  /** A Clerk account exists for the Member's email. */
  accountExists: boolean;
}

export interface ReconciledInvitation {
  state: MembersAppInvitationState;
  /** The pending invitation to act on, when there is one. */
  invitationId: string | null;
  /** `undefined`: leave the row alone; otherwise the value `invitation_id` should hold. */
  storeInvitationId?: string | null;
}

export function reconcileMemberInvitation(input: {
  linked: boolean;
  storedInvitationId: string | null;
  /** `null` when Clerk could not be asked. */
  lookup: ClerkInvitationLookup | null;
}): ReconciledInvitation {
  const stored = input.storedInvitationId || null;
  if (input.linked) return { state: 'linked', invitationId: null };

  if (!input.lookup) {
    // Keep what the row says: a stored invitation stays offered, and an empty row is
    // not proof that Clerk holds none.
    return stored
      ? { state: 'invitation_pending', invitationId: stored }
      : { state: 'unknown', invitationId: null };
  }

  const pending = input.lookup.pendingInvitationIds;
  if (stored && pending.includes(stored)) return { state: 'invitation_pending', invitationId: stored };
  if (pending.length > 0) {
    return { state: 'invitation_pending', invitationId: pending[0], storeInvitationId: pending[0] };
  }
  return {
    state: input.lookup.accountExists ? 'account_exists' : 'not_invited',
    invitationId: null,
    ...(stored ? { storeInvitationId: null } : {}),
  };
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** Clerk's pending invitations addressed to `email` (Clerk's `query` is a substring search). */
export function pendingInvitationIdsFor(
  email: string,
  invitations: Array<{ id: string; emailAddress?: string | null; status?: string | null }>,
): string[] {
  const target = norm(email);
  return invitations
    .filter((i) => norm(i.emailAddress) === target && (i.status == null || i.status === 'pending'))
    .map((i) => i.id);
}
