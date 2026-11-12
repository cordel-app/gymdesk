// #2680 — the Member ⋮ menu's Members App invitation actions follow the reconciled state.
import { describe, expect, it } from 'vitest';
import {
  INVITATION_ACTION_LABEL_KEYS,
  initialInvitationState,
  invitationMenu,
} from '../app/[locale]/members/membersAppInvitation';
import en from '../../locales/base/en.json';

describe('invitationMenu', () => {
  it('offers exactly the actions each state allows', () => {
    expect(invitationMenu('not_invited')).toEqual({ actions: ['invite'], noticeKey: null });
    expect(invitationMenu('invitation_pending')).toEqual({ actions: ['resend', 'cancel'], noticeKey: null });
    expect(invitationMenu('linked')).toEqual({ actions: [], noticeKey: null });
  });

  it('never offers Invite where an invitation may already exist', () => {
    for (const s of ['account_exists', 'unknown', 'checking'] as const) {
      expect(invitationMenu(s).actions).toEqual([]);
      expect(invitationMenu(s).noticeKey).not.toBeNull();
    }
  });

  it('uses the ticket\'s exact action names', () => {
    const m = (en as any).members;
    expect(Object.values(INVITATION_ACTION_LABEL_KEYS).map((k) => m[k.split('.')[1]])).toEqual([
      'Invite to Members App', 'Resend Members App Invitation', 'Cancel Members App Invitation',
    ]);
    for (const s of ['account_exists', 'unknown', 'checking'] as const) {
      expect(typeof m[invitationMenu(s).noticeKey!]).toBe('string');
    }
  });
});

describe('initialInvitationState', () => {
  it('a stored link is final without a read', () => {
    expect(initialInvitationState({ clerk_user_id: 'user_1' })).toBe('linked');
  });
  it('is checking until the read lands, then the API\'s state; a failed read is unknown', () => {
    expect(initialInvitationState({ clerk_user_id: null })).toBe('checking');
    expect(initialInvitationState({ clerk_user_id: null }, { invitation_state: 'invitation_pending' })).toBe('invitation_pending');
    expect(initialInvitationState({ clerk_user_id: null }, null)).toBe('unknown');
    expect(initialInvitationState({ clerk_user_id: null }, {})).toBe('checking');
  });
});
