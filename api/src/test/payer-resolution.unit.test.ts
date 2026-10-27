import { describe, expect, it } from 'vitest';
import { recordedPayer, resolvePayer } from '../domain/payerResolution';

describe('resolvePayer (#2123)', () => {
  it('a family member is paid for by the Family Owner', () => {
    expect(resolvePayer(7, 3)).toEqual({ beneficiaryMemberId: 7, payerMemberId: 3, viaFamily: true });
  });
  it('the owner pays for themselves, and a member without a family too', () => {
    expect(resolvePayer(3, 3).viaFamily).toBe(false);
    expect(resolvePayer(9, null)).toEqual({ beneficiaryMemberId: 9, payerMemberId: 9, viaFamily: false });
  });
  it('a stored row with no payer was paid by its member', () => {
    expect(recordedPayer({ member_id: 5 })).toBe(5);
    expect(recordedPayer({ member_id: 5, payer_member_id: 2 })).toBe(2);
  });
});
