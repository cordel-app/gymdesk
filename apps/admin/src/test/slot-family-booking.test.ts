import { describe, it, expect } from 'vitest';
import {
  otherFamilyMembers, familyBookingMemberIds, bookPath, familyResultErrorKey,
} from '../app/[locale]/members/slotFamilyBooking';

const family = [
  { member_id: 1, name: 'Ana', is_owner: true },
  { member_id: 2, name: 'Leo', is_owner: false },
  { member_id: 3, name: 'Mia', is_owner: false },
];

describe('slot family booking', () => {
  it('offers only the other members of the family', () => {
    expect(otherFamilyMembers(1, family).map((m) => m.member_id)).toEqual([2, 3]);
    expect(otherFamilyMembers(1, [family[0]])).toEqual([]);
  });
  it('puts the card member first and drops duplicates and strangers', () => {
    expect(familyBookingMemberIds(1, [3, 3, 9], family)).toEqual([1, 3]);
    expect(familyBookingMemberIds(2, [], family)).toEqual([2]);
  });
  it('uses the family route only with several members', () => {
    expect(bookPath(1, [1])).toBe('/members/1/personal-training-slots/book');
    expect(bookPath(1, [1, 2])).toBe('/members/1/personal-training-slots/book-family');
  });
  it('words an unavailable slot', () => {
    expect(familyResultErrorKey({ member_id: 2, created: 0, skipped: 0, failed: 0, error: 'slot_not_available' }))
      .toBe('pt_slots_family_not_available');
    expect(familyResultErrorKey({ member_id: 2, created: 1, skipped: 0, failed: 0 })).toBeNull();
  });
});
