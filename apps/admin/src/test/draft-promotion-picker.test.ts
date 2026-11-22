import { describe, expect, it } from 'vitest';
import {
  appliedOutsideOffer, assignablePromotionsPath, draftPromotionToggle, selectedDraftPromotionIds, toPickerPromotion,
} from '@/lib/assignablePromotions';

// #2853 — the Draft assigned plan's available-Promotions picker: which catalogue
// read it makes, which Promotions read as selected, and what a toggle does.
// Every rule beyond that is the server's (integration: api draft-promotion-picker).

describe('assignablePromotionsPath', () => {
  it('reads the live catalogue for the plan, judged for the owner excluding the Draft', () => {
    expect(assignablePromotionsPath({ membershipPlanId: 7, today: '2026-11-15', ownerMemberId: 3, userMembershipId: 40 }))
      .toBe('/promotions?lifecycle_status=active&active_on=2026-11-15&membership_plan_id=7&for_member_id=3&for_user_membership_id=40');
  });

  it('names no assignment without an owner (the Assign Plan form before one is chosen)', () => {
    expect(assignablePromotionsPath({ membershipPlanId: 7, today: '2026-11-15', ownerMemberId: null, userMembershipId: 40 }))
      .toBe('/promotions?lifecycle_status=active&active_on=2026-11-15&membership_plan_id=7');
  });
});

describe('Draft selection', () => {
  const applied = [
    { promotion_id: 1, status: 'applied' },
    { promotion_id: 2, status: 'revoked' },
    { promotion_id: 3, status: 'applied' },
  ];

  it('selects the standing applications only', () => {
    expect(selectedDraftPromotionIds(applied)).toEqual([1, 3]);
  });

  it('revokes a selected Promotion and applies an unselected one', () => {
    const selected = selectedDraftPromotionIds(applied);
    expect(draftPromotionToggle(selected, 1)).toBe('revoke');
    expect(draftPromotionToggle(selected, 2)).toBe('apply');
  });
});

describe('toPickerPromotion', () => {
  const t = (key: string, values?: Record<string, string | number>) => `${key}${values ? JSON.stringify(values) : ''}`;

  it('carries the thumbnail, stacking flag and the server’s eligibility reason', () => {
    const row = toPickerPromotion({
      id: 9, name: 'Spring', image_url: 'full.webp', image_thumbnail_url: 'thumb.webp', modified_at: 'm',
      stackable: 0, fee_benefit_action: 'percentage_discount', fee_benefit_value: '10', fee_benefit_duration_months: null,
      member_eligible: false, ineligible_reason: 'new_members_only',
    }, t);
    expect(row).toMatchObject({
      id: 9, name: 'Spring', stackable: false, imageUrl: 'thumb.webp', imageStamp: 'm',
      unavailableReason: 'members.promo_block_new_members_only',
    });
    expect(row.description).toContain('members.promo_desc_percent');
  });
});

// #3169 — the In Cart plan's one Promotions list: an applied Promotion is the checked entry of
// the offer, and only one the offer does not hold gets its own row, so none is drawn twice.
describe('appliedOutsideOffer (#3169)', () => {
  const app = (id: number, promotion_id: number, status = 'applied') => ({ id, promotion_id, status });
  it('keeps only applied Promotions the offer does not hold, once each', () => {
    const applied = [app(1, 10), app(2, 20), app(3, 30, 'revoked'), app(4, 40), app(5, 40)];
    expect(appliedOutsideOffer(applied, [10, 99]).map((a) => a.promotion_id)).toEqual([20, 40]);
  });
  it('draws nothing extra until the offer is known, and nothing when it holds every applied one', () => {
    expect(appliedOutsideOffer([app(1, 10)], null)).toEqual([]);
    expect(appliedOutsideOffer([app(1, 10)], [10])).toEqual([]);
  });
});

