import { describe, expect, it } from 'vitest';
import { memberInviteMetadata, memberInviteTarget } from '../domain/memberInviteTarget';

describe('memberInviteTarget (#1075)', () => {
  it('reads the member id for the same gym', () => {
    expect(memberInviteTarget(memberInviteMetadata('7', 42), '7')).toBe(42);
  });
  it.each([
    [null], [undefined], [{}], [{ member_invite: 'x' }],
    [{ member_invite: { gym_id: '8', member_id: 42 } }],
    [{ member_invite: { gym_id: '7', member_id: -1 } }],
    [{ member_invite: { gym_id: '7', member_id: 'abc' } }],
  ])('answers null for %j', (meta) => {
    expect(memberInviteTarget(meta, '7')).toBeNull();
  });
});
