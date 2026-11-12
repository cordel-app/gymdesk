// #2680 — the Members App invitation state, reconciled with what Clerk holds.
import { describe, expect, it } from 'vitest';
import { pendingInvitationIdsFor, reconcileMemberInvitation } from '../domain/memberInvitationState';

const lookup = (pendingInvitationIds: string[], accountExists = false) => ({ pendingInvitationIds, accountExists });

describe('reconcileMemberInvitation', () => {
  it('a linked member is linked whatever Clerk says, and nothing is written', () => {
    expect(reconcileMemberInvitation({ linked: true, storedInvitationId: 'inv_1', lookup: lookup(['inv_1']) }))
      .toEqual({ state: 'linked', invitationId: null });
  });

  it('no stored invitation and nothing in Clerk is not invited', () => {
    expect(reconcileMemberInvitation({ linked: false, storedInvitationId: null, lookup: lookup([]) }))
      .toEqual({ state: 'not_invited', invitationId: null });
  });

  it('stores a pending invitation the row does not know about', () => {
    expect(reconcileMemberInvitation({ linked: false, storedInvitationId: null, lookup: lookup(['inv_c']) }))
      .toEqual({ state: 'invitation_pending', invitationId: 'inv_c', storeInvitationId: 'inv_c' });
  });

  it('keeps a stored invitation Clerk still holds as pending', () => {
    expect(reconcileMemberInvitation({ linked: false, storedInvitationId: 'inv_s', lookup: lookup(['inv_x', 'inv_s']) }))
      .toEqual({ state: 'invitation_pending', invitationId: 'inv_s' });
  });

  it('replaces a stored invitation that is no longer pending with the one that is', () => {
    expect(reconcileMemberInvitation({ linked: false, storedInvitationId: 'inv_old', lookup: lookup(['inv_new']) }))
      .toEqual({ state: 'invitation_pending', invitationId: 'inv_new', storeInvitationId: 'inv_new' });
  });

  it('clears a stored invitation that is no longer pending (expired, revoked, accepted)', () => {
    expect(reconcileMemberInvitation({ linked: false, storedInvitationId: 'inv_old', lookup: lookup([]) }))
      .toEqual({ state: 'not_invited', invitationId: null, storeInvitationId: null });
  });

  it('an existing unlinked account is its own state and is never a link', () => {
    expect(reconcileMemberInvitation({ linked: false, storedInvitationId: null, lookup: lookup([], true) }))
      .toEqual({ state: 'account_exists', invitationId: null });
  });

  it('a pending invitation is reported even beside an existing account', () => {
    expect(reconcileMemberInvitation({ linked: false, storedInvitationId: null, lookup: lookup(['inv_p'], true) }).state)
      .toBe('invitation_pending');
  });

  it('a failed lookup never reports an invitation as absent and writes nothing', () => {
    expect(reconcileMemberInvitation({ linked: false, storedInvitationId: null, lookup: null }))
      .toEqual({ state: 'unknown', invitationId: null });
    expect(reconcileMemberInvitation({ linked: false, storedInvitationId: 'inv_s', lookup: null }))
      .toEqual({ state: 'invitation_pending', invitationId: 'inv_s' });
  });
});

describe('pendingInvitationIdsFor', () => {
  it('keeps only pending invitations addressed to the exact email', () => {
    expect(pendingInvitationIdsFor('Ana@X.test', [
      { id: 'a', emailAddress: 'ana@x.test', status: 'pending' },
      { id: 'b', emailAddress: 'ana@x.test', status: 'revoked' },
      { id: 'c', emailAddress: 'joana@x.test', status: 'pending' },
      { id: 'd', emailAddress: ' ANA@x.test ' },
    ])).toEqual(['a', 'd']);
  });
});
