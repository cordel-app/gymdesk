import { describe, it, expect } from 'vitest';
import { initialParticipants, isFamilyGroupService, judgeFamilyParticipants } from '../domain/familyGroupBooking';
import * as client from '../../../apps/member/src/lib/familyParticipants';

const family = [
  { member_id: 1, name: 'Zed' }, { member_id: 2, name: 'Carla' }, { member_id: 3, name: 'Anna' }, { member_id: 4, name: 'Bob' },
];

describe('family group booking rules (#2674)', () => {
  it('applies only to family_only services with a minimum above one', () => {
    expect(isFamilyGroupService({ booking_type: 'family_only', min_participants: 2 })).toBe(true);
    expect(isFamilyGroupService({ booking_type: 'family_only', min_participants: 1 })).toBe(false);
    expect(isFamilyGroupService({ booking_type: 'family_only', min_participants: null })).toBe(false);
    expect(isFamilyGroupService({ booking_type: 'open_group', min_participants: 3 })).toBe(false);
  });

  it('seeds the other family members alphabetically up to the maximum, booker excluded', () => {
    expect(initialParticipants(1, family, 3)).toEqual([3, 4]);
    expect(initialParticipants(1, family, 10)).toEqual([3, 4, 2]);
    expect(initialParticipants(1, family, 1)).toEqual([]);
  });

  it('judges the count with the booker and family membership', () => {
    const base = { bookerId: 1, familyMemberIds: [1, 2, 3, 4], min: 2, max: 3 };
    expect(judgeFamilyParticipants({ ...base, partnerIds: [2] })).toEqual({ ok: true });
    expect(judgeFamilyParticipants({ ...base, partnerIds: [] })).toEqual({ ok: false, code: 'participants_below_minimum' });
    expect(judgeFamilyParticipants({ ...base, partnerIds: [2, 3, 4] })).toEqual({ ok: false, code: 'participants_above_maximum' });
    expect(judgeFamilyParticipants({ ...base, partnerIds: [9] })).toEqual({ ok: false, code: 'participant_not_in_family' });
  });

  it('the Members App mirror agrees with the server', () => {
    expect(client.initialParticipants(1, family, 3)).toEqual(initialParticipants(1, family, 3));
    const svc = { booking_type: 'family_only', min_participants: 2, capacity: 3 };
    expect(client.isFamilyGroupService(svc)).toBe(isFamilyGroupService(svc));
    expect(client.groupLimits(svc)).toEqual({ min: 2, max: 3 });
    expect(client.participantsValid([], 2, 3)).toBe(false);
    expect(client.participantsValid([2], 2, 3)).toBe(true);
    expect(client.canAddParticipant([2, 3], 3)).toBe(false);
    expect(client.canRemoveParticipant([2], 2)).toBe(false);
    expect(client.addableMembers(1, family, [3]).map((m) => m.member_id)).toEqual([4, 2]);
  });
});
