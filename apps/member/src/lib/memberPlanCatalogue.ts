// #1122 §1–§6 — everything the Members App's **Add Plan** decides or formats,
// and nothing it draws.
//
// The split is `memberProducts.ts`' (#1121/#1118): this module answers which
// locale **key** a line reads under and how a figure is written, the
// `MemberPlanCatalogue` component is the look, and the page resolves the keys
// — so nothing here calls `t()`, no money is computed here (the server quotes
// every price, the promotion's `final_price_incl_tax` included), and both
// halves stay assertable.

import { formatPaymentAmount } from './memberPayments';
import type { GymFormatSettings } from './gymFormat';
import { promotionBenefitNote, type ProductNote } from './memberProducts';

/** One compatible Promotion, as `GET /me/membership-plans` reports it. */
export interface MemberPlanOfferPromotion {
  id: number;
  name: string;
  benefit: { action: string | null; value: number | null };
  /** The Membership Fee Benefit's own unit: calendar months (#635 §5). */
  duration_months: number | null;
  /** The first cycle's VAT-inclusive price under this Promotion — the server's figure. */
  final_price_incl_tax: number | null;
}

/** One Plan benefit line, as `GET /me/membership-plans` reports it. */
export interface MemberPlanOfferBenefit {
  section: 'session' | 'oneoff' | 'periodical';
  product_id: number;
  product_name: string;
  mandatory: boolean;
}

export function planBenefitKey(b: Pick<MemberPlanOfferBenefit, 'section' | 'product_id'>): string {
  return `${b.section}:${b.product_id}`;
}

/**
 * The request's `declined_benefits`: only unticked *optional* lines. The API's
 * `declinedBenefitsError()` is the enforcement; this never names a mandatory one.
 */
export function declinedBenefitsPayload(
  benefits: MemberPlanOfferBenefit[] | undefined, declinedKeys: ReadonlySet<string>,
): Array<{ section: string; product_id: number }> {
  return (benefits ?? [])
    .filter((b) => !b.mandatory && declinedKeys.has(planBenefitKey(b)))
    .map((b) => ({ section: b.section, product_id: b.product_id }));
}

/** #2426 — the server's overview of a plan (`memberPlanOverview.ts` on the API). */
export interface MemberPlanOverviewData {
  billing_duration: {
    free_periods: number; paid_periods: number; prepaid_periods: number; bonus_periods: number;
    billing_interval: number | null; billing_unit: string | null; auto_renew: boolean;
  };
  products: Array<{
    section: string; product_id: number; name: string; quantity: number; frequency: string | null;
    mandatory: boolean; action: string | null; value: number | null;
    original_price_incl_tax: number | null; final_price_incl_tax: number | null;
    original_line_price_incl_tax: number | null; final_line_price_incl_tax: number | null;
    declined: boolean; image_url: string | null; image_full_url: string | null;
    /** #3504 — the server's answer (`isRecurringFrequency()`); absent on an older API = One-off. */
    recurring?: boolean;
    /** #3504 — the Professional Services the Product gives access to, already localized. */
    access?: Array<{ id: number; name: string }>;
  }>;
  prepaid_end_date: string | null;
  initial_payment: number | null;
  simulation: {
    available: boolean; tax_included: boolean;
    dates: Array<{ date: string; total: number; lines: Array<{
      kind: string; label: string; actual_charge: number; regular_price: number;
      benefits: Array<{ action?: string }>;
    }> }>;
  };
}

/** One plan a member may choose, as `GET /me/membership-plans` reports it. */
export interface MemberPlanOffer {
  id: number;
  name: string;
  description: string | null;
  image_url?: string | null;
  image_full_url?: string | null;
  /** #3091 — *Members per Membership*: how many the plan must cover; absent from an older API. */
  member_limit?: '1' | '2' | 'family';
  price_incl_tax: number | null;
  tax_included: boolean;
  billing_interval: number | null;
  billing_unit: string | null;
  promotions: MemberPlanOfferPromotion[];
  /** The Plan's benefit lines (#1184 stage 3b); absent from an older API. */
  benefits?: MemberPlanOfferBenefit[];
  /** #2426 — absent from an older API. */
  overview?: MemberPlanOverviewData | null;
}

/** The member's plan awaiting its first payment, as `GET /me/membership` reports it. */
export interface MemberPendingPlan {
  id: number;
  plan_name: string | null;
  starts_at: string | null;
  membership_fee: number | null;
  /** The plan's own cadence (#1081): what the consent says it will charge "every". */
  billing_interval?: number | null;
  billing_unit?: string | null;
}

/**
 * Which `membership.frequency` key the plan's cadence reads under — the one
 * map the Products already use (#1128) — or `null` for a cadence that map has
 * no word for, which the page then spells as the pair.
 */
export function planFrequencyKey(plan: Pick<MemberPlanOffer, 'billing_interval' | 'billing_unit'>): string | null {
  const { billing_interval: interval, billing_unit: unit } = plan;
  if (interval === 1 && unit === 'month') return 'membership.frequency.month';
  if (interval === 4 && unit === 'week') return 'membership.frequency.four_weeks';
  if (interval === 1 && unit === 'year') return 'membership.frequency.year';
  return null;
}

/** The catalogue price, formatted; `null` for a plan with no price (reads `—`). */
export function planPriceText(plan: Pick<MemberPlanOffer, 'price_incl_tax'>, gym?: GymFormatSettings, currency = 'EUR'): string | null {
  return plan.price_incl_tax == null ? null : formatPaymentAmount(plan.price_incl_tax, currency, gym);
}

/**
 * The final price the card shows, given the Promotion the member applied in
 * the page (if any): the Promotion's own server-quoted figure replaces the
 * plan's price rather than being recomputed here.
 */
export function planFinalPrice(plan: MemberPlanOffer, appliedPromotionId: number | null): number | null {
  if (appliedPromotionId == null) return plan.price_incl_tax;
  const applied = plan.promotions.find((p) => p.id === appliedPromotionId);
  return applied?.final_price_incl_tax ?? plan.price_incl_tax;
}

export function planFinalPriceText(plan: MemberPlanOffer, appliedPromotionId: number | null, gym?: GymFormatSettings, currency = 'EUR'): string | null {
  const price = planFinalPrice(plan, appliedPromotionId);
  return price == null ? null : formatPaymentAmount(price, currency, gym);
}

/** *50% discount* — the same vocabulary and keys the Products use. */
export function planPromotionBenefitNote(promotion: MemberPlanOfferPromotion, gym?: GymFormatSettings, currency = 'EUR'): ProductNote | null {
  if (!promotion.benefit.action) return null;
  return promotionBenefitNote(promotion.benefit.action, promotion.benefit.value, currency, gym);
}

/** *3 months* — the Membership Fee Benefit's own unit, never relabelled as cycles. */
export function planPromotionDurationNote(promotion: MemberPlanOfferPromotion): ProductNote | null {
  if (promotion.duration_months == null || promotion.duration_months <= 0) return null;
  return { key: 'membership.promotion_duration_months', values: { count: promotion.duration_months } };
}

/** A first cycle that owes nothing is activated with no payment to make (#1108 stage 2). */
export function choosingOwesNothing(plan: MemberPlanOffer, appliedPromotionId: number | null): boolean {
  const price = planFinalPrice(plan, appliedPromotionId);
  return price == null || price <= 0;
}

/** The refusal a `POST /me/membership-plans/:id/assign` answers, as the member's own key. */
export function assignErrorKey(message: string | null | undefined): string {
  if (message === 'active_plan_exists') return 'membership.add_plan_replace_body';
  if (message === 'plan_pending_payment') return 'membership.add_plan_pending_error';
  if (message === 'awaiting_staff_setup') return 'membership.cart_error_awaiting_staff';
  if (message === 'family_owner_only') return 'membership.family_owner_only';
  return 'membership.add_plan_error';
}

/* ── #3091 — who the plan covers, chosen while contracting ──────────────────
 * The server (`beneficiarySelectionError()`) is the enforcement; these only
 * seed the selection, keep the count honest on screen and shape the payload. */

export interface FamilyMemberOption { member_id: number; name: string }

/** How many beneficiaries a plan requires, or `null` for a family plan (any count ≥ 1). */
export function requiredBeneficiaries(limit: MemberPlanOffer['member_limit']): number | null {
  if (limit === 'family') return null;
  return limit === '2' ? 2 : 1;
}

/** The starting selection: the member first, then the others, up to the plan's count (the whole family for a family plan). */
export function defaultBeneficiaryIds(limit: MemberPlanOffer['member_limit'], family: readonly FamilyMemberOption[]): number[] {
  const required = requiredBeneficiaries(limit);
  const ids = family.map((m) => m.member_id);
  return required == null ? ids : ids.slice(0, required);
}

/** A beneficiary ticked or unticked; the member is not locked in. */
export function toggleBeneficiary(selected: readonly number[], id: number): number[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** The locale key of what is wrong with the selection, or `null` when it meets the plan's count. */
export function beneficiaryCountErrorKey(limit: MemberPlanOffer['member_limit'], selected: readonly number[]): string | null {
  if (selected.length === 0) return 'membership.beneficiaries_required';
  const required = requiredBeneficiaries(limit);
  return required != null && selected.length !== required ? `membership.beneficiaries_count_${required}` : null;
}

/** The picker is offered only to a member with a family to choose from. */
export function offersBeneficiaryChoice(family: readonly FamilyMemberOption[] | null | undefined): boolean {
  return (family?.length ?? 0) > 1;
}

/**
 * #3504 — how one included item of a plan is provided, as locale **keys**: One-off
 * or Recurring (the server's `recurring`, never re-derived) and the access it
 * gives (its Products' Professional Services). The page resolves the keys and
 * the frequency label; an item with no service says so rather than inventing one.
 */
export function planItemProvision(p: { recurring?: boolean; access?: Array<{ name: string }> }): {
  kindKey: 'membership.plan_ov_recurring' | 'membership.plan_ov_one_off';
  recurring: boolean;
  accessKey: 'membership.plan_ov_access' | 'membership.plan_ov_access_none';
  accessNames: string | null;
} {
  const recurring = p.recurring === true;
  const names = (p.access ?? []).map((a) => a.name).filter((n) => n && n.trim() !== '');
  return {
    kindKey: recurring ? 'membership.plan_ov_recurring' : 'membership.plan_ov_one_off',
    recurring,
    accessKey: names.length > 0 ? 'membership.plan_ov_access' : 'membership.plan_ov_access_none',
    accessNames: names.length > 0 ? names.join(', ') : null,
  };
}
