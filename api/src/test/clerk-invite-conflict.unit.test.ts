import { describe, expect, it } from 'vitest';
import { listItems, resolveInviteConflict } from '../domain/clerkInviteConflict';

const inv = (id: string, email: string, status = 'pending') => ({ id, emailAddress: email, status });
const usr = (id: string, email: string) => ({ id, emailAddresses: [{ emailAddress: email }] });

describe('resolveInviteConflict (#2183)', () => {
  it('finds a pending invitation for the email, case-insensitively', () => {
    expect(resolveInviteConflict('Ann@x.com', [inv('inv_1', 'ann@X.com')], [])).toEqual({ kind: 'pending_invitation', invitationId: 'inv_1' });
  });
  it('ignores invitations for other emails or no longer pending', () => {
    expect(resolveInviteConflict('a@x.com', [inv('i', 'b@x.com'), inv('j', 'a@x.com', 'revoked')], [])).toEqual({ kind: 'unknown' });
  });
  it('an existing account outranks a pending invitation', () => {
    expect(resolveInviteConflict('a@x.com', [inv('i', 'a@x.com')], [usr('user_1', 'a@x.com')])).toEqual({ kind: 'account_exists', userId: 'user_1' });
  });
  it('reads both list shapes', () => {
    expect(listItems({ data: [1] })).toEqual([1]);
    expect(listItems([2])).toEqual([2]);
    expect(listItems(undefined)).toEqual([]);
  });
});
