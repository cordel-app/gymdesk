// #2853 — a Promotion offered for a Membership Plan assignment, as the live
// catalogue (`GET /promotions?…&membership_plan_id=&for_member_id=`) reports it,
// and how it becomes a `PromotionPicker` row. One mapping for the two places a
// plan's Promotions are chosen: the Assign Plan form (#2809) and the Draft
// Assigned Plan card (#2853). Pure: the caller hands in its translator.

import type { PickerPromotion } from '@/components/PromotionPicker';
import { promotionBenefitDescription } from '@/lib/promotionSelection';

/** A Promotion targeting the Plan, from the `promotions` table (never a snapshot). */
export interface AssignablePromotion {
  id: number;
  name: string;
  /** #2852: the Promotion's stored images, for the picker's thumbnail. */
  image_url?: string | null;
  image_thumbnail_url?: string | null;
  modified_at?: string | null;
  stackable: number | boolean;
  fee_benefit_action: string | null;
  fee_benefit_value: number | string | null;
  fee_benefit_duration_months: number | null;
  /** The owner may take it (#2809); absent when no owner is chosen yet. */
  member_eligible?: boolean;
  ineligible_reason?: string | null;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The catalogue read a plan's picker makes: active today, targeting the plan, judged for the owner. */
export function assignablePromotionsPath(opts: {
  membershipPlanId: number;
  today: string;
  ownerMemberId?: number | null;
  /** #2853: the assignment being edited, so Only New Members excludes it. */
  userMembershipId?: number | null;
}): string {
  const owner = opts.ownerMemberId != null ? `&for_member_id=${opts.ownerMemberId}` : '';
  const assignment = opts.ownerMemberId != null && opts.userMembershipId != null
    ? `&for_user_membership_id=${opts.userMembershipId}` : '';
  return `/promotions?lifecycle_status=active&active_on=${opts.today}`
    + `&membership_plan_id=${opts.membershipPlanId}${owner}${assignment}`;
}

/** The picker row: thumbnail, name, fee-benefit description and the eligibility reason. */
export function toPickerPromotion(p: AssignablePromotion, t: Translate): PickerPromotion {
  const d = p.fee_benefit_action
    ? promotionBenefitDescription(
        {
          action: p.fee_benefit_action,
          value: p.fee_benefit_value == null ? null : Number(p.fee_benefit_value),
          duration_cycles: p.fee_benefit_duration_months ?? null,
        },
        (n) => `${n.toFixed(2)}€`,
      )
    : null;
  return {
    id: p.id,
    name: p.name,
    stackable: !!p.stackable,
    description: d ? t(`members.${d.key}`, d.values) : null,
    imageUrl: p.image_thumbnail_url ?? p.image_url ?? null,
    imageStamp: p.modified_at ?? null,
    unavailableReason: p.member_eligible === false
      ? t(`members.promo_block_${p.ineligible_reason ?? 'new_members_only'}`)
      : null,
  };
}

/** The Promotions the Draft holds now: one standing application each (`ump_one_standing_per_promotion`). */
export function selectedDraftPromotionIds(applied: readonly { promotion_id: number; status: string }[]): number[] {
  return [...new Set(applied.filter((a) => a.status === 'applied').map((a) => Number(a.promotion_id)))];
}

/** What ticking or unticking one Promotion does to the Draft: apply it, or revoke its application. */
export function draftPromotionToggle(selectedIds: readonly number[], promotionId: number): 'apply' | 'revoke' {
  return selectedIds.includes(promotionId) ? 'revoke' : 'apply';
}

/**
 * #3169 — the Draft's applied Promotions the checkbox list does not offer (no longer targeting the
 * plan, outside its dates): drawn as their own checked rows under the list, so each applied
 * Promotion is shown exactly once and can still be unticked. Empty until the offer is known.
 */
export function appliedOutsideOffer<T extends { promotion_id: number; status: string }>(
  applied: readonly T[], offeredIds: readonly number[] | null,
): T[] {
  if (offeredIds == null) return [];
  const offered = new Set(offeredIds.map(Number));
  const seen = new Set<number>();
  return applied.filter((a) => {
    const id = Number(a.promotion_id);
    if (a.status !== 'applied' || offered.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
