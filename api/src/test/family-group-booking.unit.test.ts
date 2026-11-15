import { describe, it, expect } from 'vitest';
import { cancelsRemainingFamilyBookings, initialParticipants, isFamilyGroupService, judgeFamilyParticipants, parseBookerAttends } from '../domain/familyGroupBooking';
import * as client from '../../../apps/member/src/lib/familyParticipants';

const family = [
  { member_id: 1, name: 'Zed' }, { member_id: 2, name: 'Carla' }, { member_id: 3, name: 'Anna' }, { member_id: 4, name: 'Bob' },
];

describe('family group booking rules (#2674)', () => {
  it('applies to every family_only service, whatever its minimum (#2813 §1)', () => {
    expect(isFamilyGroupService({ booking_type: 'family_only', min_participants: 2 })).toBe(true);
    expect(isFamilyGroupService({ booking_type: 'family_only', min_participants: 1 })).toBe(true);
    expect(isFamilyGroupService({ booking_type: 'family_only', min_participants: null })).toBe(true);
    expect(isFamilyGroupService({ booking_type: 'open_group', min_participants: 3 })).toBe(false);
    expect(client.isFamilyGroupService({ booking_type: 'family_only', min_participants: 1, capacity: 3 })).toBe(true);
  });

  it('cancels the remaining family bookings only when some remain below the minimum (#2813 §6)', () => {
    expect(cancelsRemainingFamilyBookings(2, 2)).toBe(false);
    expect(cancelsRemainingFamilyBookings(1, 2)).toBe(true);
    expect(cancelsRemainingFamilyBookings(0, 2)).toBe(false);
    expect(cancelsRemainingFamilyBookings(1, 1)).toBe(false);
    expect(cancelsRemainingFamilyBookings(1, null)).toBe(false);
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

  // #2674 follow-up (2026-11-12): the selection showed only once a service was
  // chosen, so a member whose balance preselected nothing never saw it.
  it('shows the selection for the event\'s one qualifying service even when none is chosen', () => {
    const fam = { id: 7, booking_type: 'family_only', min_participants: 2, capacity: 4 };
    const open = { id: 8, booking_type: 'open_group', min_participants: null, capacity: 4 };
    expect(client.groupServiceOf([fam], null)?.id).toBe(7);
    expect(client.groupServiceOf([open, fam], null)?.id).toBe(7);
    expect(client.groupServiceOf([open, fam], 8)).toBeNull();
    expect(client.groupServiceOf([fam, { ...fam, id: 9 }], null)).toBeNull();
    expect(client.groupServiceOf([fam, { ...fam, id: 9 }], 9)?.id).toBe(9);
    expect(client.groupServiceOf(null, null)).toBeNull();
  });

  it('toggles a family member within the limits, keeping the alphabetical order', () => {
    // min 2, max 3 (booker included): partners 1..2
    expect(client.toggleParticipant(1, family, [3], 4, 2, 3)).toEqual([3, 4]);
    expect(client.toggleParticipant(1, family, [4], 3, 2, 3)).toEqual([3, 4]);
    expect(client.toggleParticipant(1, family, [3, 4], 2, 2, 3)).toEqual([3, 4]); // max reached
    expect(client.toggleParticipant(1, family, [3, 4], 4, 2, 3)).toEqual([3]);
    expect(client.toggleParticipant(1, family, [3], 3, 2, 3)).toEqual([3]); // min reached
    expect(client.toggleParticipant(1, family, [3], 1, 2, 3)).toEqual([3]); // booker is locked
    expect(client.toggleParticipant(1, family, [3], 99, 2, 3)).toEqual([3]); // not in the family
    expect(client.canToggleParticipant([3, 4], 2, 2, 3)).toBe(false);
    expect(client.canToggleParticipant([3, 4], 4, 2, 3)).toBe(true);
  });

  it('lets the booker stay out of the count (#2850)', () => {
    const base = { bookerId: 1, familyMemberIds: [1, 2, 3, 4], min: 2, max: 3, bookerAttends: false };
    expect(judgeFamilyParticipants({ ...base, partnerIds: [2, 3] })).toEqual({ ok: true });
    expect(judgeFamilyParticipants({ ...base, partnerIds: [2] })).toEqual({ ok: false, code: 'participants_below_minimum' });
    expect(judgeFamilyParticipants({ ...base, min: 1, partnerIds: [] })).toEqual({ ok: false, code: 'participants_below_minimum' });
    expect(judgeFamilyParticipants({ ...base, partnerIds: [2, 3, 4] })).toEqual({ ok: true });
    expect(parseBookerAttends(undefined)).toEqual({ ok: true, value: true });
    expect(parseBookerAttends(false)).toEqual({ ok: true, value: false });
    expect(parseBookerAttends('false').ok).toBe(false);
    // The mirror agrees.
    expect(client.participantsValid([2, 3], 2, 3, false)).toBe(true);
    expect(client.participantsValid([2], 2, 3, false)).toBe(false);
    expect(client.participantsValid([], 1, 3, false)).toBe(false);
    expect(client.participantsValid([2, 3, 4], 2, 3, false)).toBe(true);
  });

  it('moves the booker\'s own toggle within the limits (#2850)', () => {
    expect(client.canToggleSelf([2], true, 1, 3)).toBe(true);   // switch off: one child remains
    expect(client.canToggleSelf([], true, 1, 3)).toBe(false);   // nobody would remain
    expect(client.canToggleSelf([2, 3, 4], false, 1, 3)).toBe(false); // switching on exceeds max
    expect(client.canToggleSelf([2], false, 1, 3)).toBe(true);
    // With the booker out, one more child fits.
    expect(client.canToggleParticipant([2, 3], 4, 1, 3, false)).toBe(true);
    expect(client.toggleParticipant(1, family, [3, 4], 2, 1, 3, false)).toEqual([3, 4, 2]);
  });
});
