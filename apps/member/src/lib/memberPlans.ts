// #1122 §7/§8 — everything the Members App's **Past Membership Plans** card
// decides or formats, and nothing it draws.
//
// The split is `memberPayments.ts`' (#1123) and `memberProducts.ts`' (#1121):
// this module answers which locale **key** a row reads under and how its date is
// written, `components/PastMembershipPlansCard.tsx` is the look, and the page
// resolves the keys — so nothing here calls `t()` and both halves stay
// assertable (`api/src/test/member-past-plans.unit.test.ts`, in the API suite
// because CI runs `npm test` in `api/` only).
//
// Three of its answers are the rule rather than the implementation.
//
//  - **Which plans are past is the server's.** `GET /me/membership` answers the
//    member's current plan and `past_memberships` from one ordering
//    (`MEMBER_CURRENT_ASSIGNMENT_ORDER` plus `splitMemberPlanHistory()`), so the
//    page never filters a list by status for itself — a client-side rule is how
//    a plan comes to be named in the card above *and* listed in the history
//    under it.
//  - **A past plan shows no money and no action** (§8: the section exists for
//    historical visibility and must not carry an active plan's actions), so a
//    row is a name and one muted line. There is no price, no pill and no
//    control to word here.
//  - **A missing date is an absence, never a guess.** A row that carries
//    neither an end date nor a closing stamp reads as its status alone rather
//    than falling back to the day it *started*, which would tell a member their
//    plan ended on the day it began.

import { formatPaymentAmount, formatPaymentDate } from './memberPayments';
import type { GymFormatSettings } from './gymFormat';

/** One row of `past_memberships`, as `GET /me/membership` reports it. */
export interface MemberPastPlan {
  id: number;
  membership_plan_id: number | null;
  plan_name: string | null;
  status: string;
  /** #2660: the Admin's status for the same assignment, shown as is. */
  lifecycle_status?: string;
  starts_at: string | null;
  /** The day it stopped running: its `ends_at`, else when it was closed. */
  ended_on: string | null;
  /** #2747 stage 2: set when the row is a plan cancelled while awaiting payment (a Product Set). */
  product_set_id?: number;
  /** #2779: the plan's Product lines and Promotions, from its snapshots. */
  details?: PastPlanDetails;
}

/** The locale key naming what became of a past plan — the `membership.status` map. */
export function pastPlanStatusKey(plan: MemberPastPlan): string {
  // #2660: the status the Admin shows (`lifecycle_status`), never a mapping of
  // our own; the stored one only for a response that predates it.
  return `membership.status.${plan.lifecycle_status ?? plan.status}`;
}

/**
 * The name of a past plan. A row whose Membership Plan has since been deleted
 * has no name left to show, and `—` is what every other member-facing surface
 * renders for one.
 */
export function pastPlanName(plan: MemberPastPlan): string {
  return plan.plan_name ?? '—';
}

/**
 * The date under it, formatted in the member's own locale — `null` where the
 * row carries none, which is what makes the line read as the status alone.
 */
export function pastPlanEndedOn(plan: MemberPastPlan, gym?: GymFormatSettings): string | null {
  return plan.ended_on ? formatPaymentDate(plan.ended_on, gym) : null;
}

/* ── #2779: the expanded Past Plan ─────────────────────────────────────────
 *
 * The header carries the plan's start and end dates; expanding it shows the
 * Product lines and Promotions it was agreed with, all of which `GET /me/membership`
 * read from the plan's snapshots (`details`). This module only picks locale keys
 * and formats what the server sent — it computes no price and reads no catalogue.
 * A line reports no amount on purpose: its snapshot does not freeze whether its
 * unit price is VAT-inclusive (the server's `domain/pastPlanDetails.ts` says why).
 */

export interface PastPlanLine {
  category: 'session' | 'oneoff' | 'periodical';
  product_name: string;
  product_type: string | null;
  billing_frequency: string | null;
  session_frequency: string | null;
  quantity: number;
  mandatory: boolean;
  action: string;
  value: number | null;
  direct_discount_percent: number | null;
}

export interface PastPlanPromotion {
  id: number;
  name: string | null;
  status: string;
  applied_at: string | null;
  revoked_at: string | null;
  membership_fee_benefits: Array<{ action: string; value: number | null; duration_months: number | null }>;
  products: Array<{ product_name: string; quantity: number; action: string; value: number | null }>;
}

export interface PastPlanDetails {
  membership_fee_price: number | null;
  billing_interval: number | null;
  billing_unit: string | null;
  lines: PastPlanLine[];
  promotions: PastPlanPromotion[];
}

/** A locale key plus its interpolation values, resolved by the page. */
export interface PastPlanText {
  key: string;
  values?: Record<string, string | number>;
}

/** The header's period line: start – end, start alone, end alone, or nothing. */
export function pastPlanPeriod(plan: MemberPastPlan, gym?: GymFormatSettings): PastPlanText | null {
  const start = plan.starts_at ? formatPaymentDate(plan.starts_at, gym) : null;
  const end = pastPlanEndedOn(plan, gym);
  if (start && end) return { key: 'membership.past_plan_period', values: { start, end } };
  if (start) return { key: 'membership.past_plan_period_start', values: { start } };
  if (end) return { key: 'membership.past_plan_period_end', values: { end } };
  return null;
}

/** Whether expanding the plan has anything to show. */
export function pastPlanHasDetails(details: PastPlanDetails | null | undefined): boolean {
  if (!details) return false;
  return details.membership_fee_price != null || details.lines.length > 0 || details.promotions.length > 0;
}

const PRODUCT_TYPES = ['fee', 'service', 'sessions', 'merchandise', 'other'];
const FREQUENCIES = ['once', 'per_session', 'week', 'four_weeks', 'month', 'year'];

/** The key naming a line's Product type, `null` for a type this app has no label for. */
export function pastPlanLineTypeKey(line: PastPlanLine): string | null {
  return line.product_type && PRODUCT_TYPES.includes(line.product_type)
    ? `membership.past_plan_type_${line.product_type}` : null;
}

/**
 * The frequency a line is read under: a Session Benefit's renewal frequency where it
 * has one (#918), else the Product's own billing frequency — through the one
 * `membership.frequency` map (#1128).
 */
export function pastPlanLineFrequencyKey(line: PastPlanLine): string | null {
  const value = line.category === 'session' && line.session_frequency ? line.session_frequency : line.billing_frequency;
  return value && FREQUENCIES.includes(value) ? `membership.frequency.${value}` : null;
}

/** The line's Benefit treatment, `null` for `no_benefit` (which says nothing). */
export function pastPlanBenefitText(action: string, value: number | null): PastPlanText | null {
  if (action === 'waive') return { key: 'membership.promotion_benefit_waive' };
  if (action === 'percentage_discount' && value != null) {
    return { key: 'membership.promotion_benefit_percentage', values: { value } };
  }
  return null;
}

/** The facts under a line's name, in reading order. */
export function pastPlanLineFacts(line: PastPlanLine): PastPlanText[] {
  const facts: PastPlanText[] = [];
  const typeKey = pastPlanLineTypeKey(line);
  if (typeKey) facts.push({ key: typeKey });
  facts.push({ key: 'membership.past_plan_quantity', values: { count: line.quantity } });
  const frequencyKey = pastPlanLineFrequencyKey(line);
  if (frequencyKey) facts.push({ key: frequencyKey });
  facts.push({ key: line.mandatory ? 'membership.plan_ov_mandatory' : 'membership.plan_ov_optional' });
  const benefit = pastPlanBenefitText(line.action, line.value);
  if (benefit) facts.push(benefit);
  if (line.direct_discount_percent != null) {
    facts.push({ key: 'membership.past_plan_direct_discount', values: { value: line.direct_discount_percent } });
  }
  return facts;
}

/** A Promotion's own treatment of a Product or the fee — the five Promotion actions. */
export function pastPromotionBenefitText(
  action: string, value: number | null, currency: string | null | undefined, gym?: GymFormatSettings,
): PastPlanText | null {
  if (action === 'fixed_discount' || action === 'fixed_price') {
    const amount = formatPaymentAmount(value, currency ?? 'EUR', gym);
    if (!amount) return null;
    return { key: `membership.promotion_benefit_${action}`, values: { amount } };
  }
  return pastPlanBenefitText(action, value);
}

/** The Promotion's name as applied; `null` when its snapshot holds none (the page shows the generic heading). */
export function pastPromotionName(promotion: PastPlanPromotion): string | null {
  return promotion.name && promotion.name.trim() !== '' ? promotion.name : null;
}
