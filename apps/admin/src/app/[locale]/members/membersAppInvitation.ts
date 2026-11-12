// #2680 — which Members App invitation actions the Member's ⋮ menu offers.
//
// The state is the API's (`GET /members/:id/clerk-status` → `invitation_state`), read
// when the menu opens, so the menu follows what Clerk actually holds rather than the
// list row's stored `invitation_id`. This module decides nothing about the state; it
// only maps it to actions and to the one informative line the menu shows instead.
//
// Pure — no React, no t().

export type MembersAppInvitationState =
  | 'linked'
  | 'invitation_pending'
  | 'account_exists'
  | 'not_invited'
  | 'unknown';

/** `checking` is the menu's own state while the read is in flight. */
export type InvitationMenuState = MembersAppInvitationState | 'checking';

export type InvitationActionId = 'invite' | 'resend' | 'cancel';

export interface InvitationMenu {
  actions: InvitationActionId[];
  /** A disabled line saying why no invitation action is offered (`members.<key>`). */
  noticeKey: string | null;
}

export const INVITATION_ACTION_LABEL_KEYS: Record<InvitationActionId, string> = {
  invite: 'members.action_invite',
  resend: 'members.action_reinvite',
  cancel: 'members.action_revoke',
};

export function invitationMenu(state: InvitationMenuState): InvitationMenu {
  switch (state) {
    case 'not_invited': return { actions: ['invite'], noticeKey: null };
    case 'invitation_pending': return { actions: ['resend', 'cancel'], noticeKey: null };
    case 'linked': return { actions: [], noticeKey: null };
    // Never invite on top of an account that exists, nor link it from here: /me/link does that.
    case 'account_exists': return { actions: [], noticeKey: 'invitation_account_exists' };
    // A failed Clerk read must not offer Invite (it may be pending) nor claim one is.
    case 'unknown': return { actions: [], noticeKey: 'invitation_status_unavailable' };
    case 'checking': return { actions: [], noticeKey: 'invitation_status_checking' };
  }
}

const STATES: readonly string[] = ['linked', 'invitation_pending', 'account_exists', 'not_invited', 'unknown'];

/** The state before (or without) the read: a stored link is final, anything else is checked. */
export function initialInvitationState(
  row: { clerk_user_id?: string | null },
  read?: { invitation_state?: string | null } | null,
): InvitationMenuState {
  if (row.clerk_user_id) return 'linked';
  const s = read?.invitation_state;
  if (s && STATES.includes(s)) return s as MembersAppInvitationState;
  return read === null ? 'unknown' : 'checking';
}
