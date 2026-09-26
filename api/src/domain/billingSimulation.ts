// #629 (stage 1 — the Billing Simulation engine).
//
// A read-only, never-persisted forecast of what a Member will actually be
// charged: it resolves, for every projected billing event,
//
//     regular price -> promotion -> benefit -> ACTUAL CHARGE
//
// and keeps the reason for the difference attached to the line, so the
// simulation explains *why* an amount differs from the regular price rather
// than only showing the promotional configuration (#629 §2, §4, §7).
//
// Pure calculation — no DB access, no persistence (#629 §8). The caller
// (`api/src/api/billing-simulation.ts`) does the reads and hands this module
// already-normalized (YYYY-MM-DD) inputs, the same split
// `assignedPlanBillingEvents.ts` uses, so it is unit-testable without
// `createTestGym`/`db` (see CLAUDE.md's unit-vs-integration test guidance).
//
// Scope of stage 1, per the #629 thread's Q1 answer: the simulation covers the
// membership price, one-off prices, periodic benefits, session benefits and
// the applied Promotions. Plan Charge Benefits (`user_membership_charge_
// benefits`) are deliberately NOT an input — they are being decommissioned by
// a follow-up ticket.
//
// #631 adds Additional Periodic Services: recurring Sellable Items attached
// directly to an assignment. They are plain items on the assignment, not
// Promotion benefits (#631 §7) — each is its own stream, billed at the
// Sellable Item's own frequency and price over its own effective window, so
// the horizon rule below covers them exactly as it covers everything else.
//
// #635 stage 3 adds the Assigned Plan's own benefit sections (One-off /
// Session / Period Benefits, frozen onto the assignment at assignment time).
// They are *charged* items, not free ones: the Plan says the member gets a
// locker, the member pays the frozen price for it, and a Promotion granting
// the same Sellable Item is what makes a period free. A Plan item and the
// Promotion grants covering it are therefore merged into one stream per
// Sellable Item — two independent streams would bill the locker twice.
//
// #635 stage 8 adds the assignment's own **Billing & Duration**: its Free
// Period and Bonus Duration waive the Membership Fee (§7), and where an applied
// Promotion governs the same date the Promotion decides it alone — the thread's
// Q2 answer, "in case of conflict, prioritize the promotion".
//
// #635 stage 12 makes `resolveMembershipFee` below the *only* implementation of
// "what does the Membership Fee cost on this date": the Billing Events
// projection, the Member's My Membership page, promotion apply/revoke and the
// nightly run all call it, so none of them can price a cycle differently from
// what the Member was shown. A Promotion's Membership Fee Benefit therefore ends
// with the Promotion's own Free/Paid/Bonus timeline everywhere (the thread's
// stage 12 answer (a)); since stage 15 there is no stored agreed price left for
// one of them to survive in.

import { advanceBillingDate } from './billingDate';
import {
  PlanDuration,
  PlanDurationStatus,
  classifyPlanDurationPeriod,
  planDurationWaivesFee,
} from './planDuration';
import { applyPeriodBenefit, PromotionBenefitAction } from './promotionBenefits';
import {
  AppliedPromotionForBilling,
  MembershipFeeBenefit,
  promotionCoversDate,
} from './promotionApplication';
import {
  PromotionTimelineStatus,
  computePromotionTimeline,
} from './promotionTimeline';
import { SellableItemBenefitCategory } from './sellableItemClassification';

export type BillingUnit = 'day' | 'week' | 'month' | 'year';

/** `gym_charges.billing_frequency` (migrations 090/102/123). */
export type SellableItemFrequency = 'once' | 'per_session' | 'week' | 'four_weeks' | 'month' | 'year';

/**
 * The simulation's groups, in the order #629 §3 fixes them: one-off charges
 * first, then year, then monthly, then 4-week. `week`, `session` and `other`
 * are appended after those four because the catalogue can produce them
 * (`gym_charges.billing_frequency` also allows `week`/`per_session`, and a
 * Plan's `billing_policies` cadence is a free (interval, unit) pair) and the
 * ticket's four sections have nowhere to put them.
 */
export type SimulationSection = 'one_off' | 'year' | 'month' | 'four_weeks' | 'week' | 'session' | 'other';

export const SECTION_ORDER: readonly SimulationSection[] = [
  'one_off', 'year', 'month', 'four_weeks', 'week', 'session', 'other',
];

// How far the projection will ever run, as a safety net: a promotion that
// grants an indefinite Membership Fee benefit and is never revoked has no
// natural end, so "continue to the first regular milestone" (#629 §6) would
// otherwise never terminate. Mirrors assignedPlanBillingEvents.ts's own cap.
const MAX_SIMULATION_MONTHS = 36;

// Upper bound on the scan that locates an occurrence index — a weekly cadence
// over the longest projection is ~156 steps, so this is never reached in
// practice; it only stops a degenerate cadence from spinning.
const MAX_OCCURRENCE_SCAN = 2000;

/**
 * A Promotion, as the simulation needs it: its window, its timeline shape and
 * what it grants. Everything but the grants is `AppliedPromotionForBilling` —
 * the shape every other fee-pricing path already reads (#635 stage 12).
 */
export interface SimulationPromotion extends AppliedPromotionForBilling {
  name: string | null;
  /** Sellable Items granted by this Promotion (`promotion_session` / `_oneoff` / `_periodical`). */
  grants: SimulationGrant[];
}

export interface SimulationGrant {
  gymChargeId: number;
  name: string;
  category: SellableItemBenefitCategory;
  billingFrequency: SellableItemFrequency | null;
  unitPrice: number;
  /**
   * What the Promotion grants: for a `session` or `oneoff` item the number of
   * units covered, for a `periodical` item the number of billing periods
   * covered (`promotion_periodical.quantity`).
   */
  quantity: number;
}

/**
 * #631 — an Additional Periodic Service: a recurring Sellable Item attached to
 * the assignment itself. Billed at the item's own `billing_frequency` and
 * price, over the window it is attached for (`endsOn` is the effective removal
 * date, so removing a service only ever stops future charges).
 */
export interface SimulationService {
  id: number;
  gymChargeId: number;
  name: string;
  billingFrequency: SellableItemFrequency | null;
  unitPrice: number;
  quantity: number;
  startsOn: string;
  endsOn: string | null;
}

/**
 * #635 — a Sellable Item the Assigned Plan itself carries: a One-off, Session
 * or Period Benefit of the Membership Plan, copied onto the assignment when it
 * was created (`user_membership_oneoff` / `_session` / `_periodical`).
 *
 * Unlike a Promotion grant it is charged, at the price frozen with it: the
 * Plan decides the member gets a locker, not that the locker is free.
 */
export interface SimulationPlanBenefit {
  gymChargeId: number;
  name: string;
  category: SellableItemBenefitCategory;
  billingFrequency: SellableItemFrequency | null;
  unitPrice: number;
  /** Units billed — per period for a Period Benefit, once for the other two. */
  quantity: number;
}

export interface SimulationAssignment {
  userMembershipId: number;
  planName: string | null;
  startsAt: string;
  endsAt: string | null;
  /** The Plan's regular price at the assignment date — before any Promotion. */
  membershipFeePrice: number | null;
  recurringInterval: number | null;
  recurringUnit: BillingUnit | null;
  promotions: SimulationPromotion[];
  /** #631 — Additional Periodic Services attached to this assignment. */
  services: SimulationService[];
  /** #635 — the Plan's own benefit sections, as frozen onto this assignment. */
  planBenefits: SimulationPlanBenefit[];
  /**
   * #635 stage 8 — the assignment's own Billing & Duration (Free Period / Paid
   * Duration / Bonus Duration), frozen at assignment time. Counted from
   * `startsAt`, not from any Promotion's application date.
   */
  planDuration: PlanDuration;
}

/**
 * Everything the Membership Fee of one assignment depends on, on a given date:
 * the contract's own anchor and Billing & Duration, plus the Promotions applied
 * to it. `SimulationAssignment` satisfies it, and so does the far smaller row
 * the nightly run reads (#635 stage 11) — which is the point: both price a
 * cycle through `resolveMembershipFee`, so neither can drift from the other.
 */
export interface MembershipFeeContext {
  startsAt: string;
  planDuration: PlanDuration;
  /**
   * The applications still standing on the assignment. Typed as the shared
   * `AppliedPromotionForBilling` rather than `SimulationPromotion` since #635
   * stage 12, so a caller that prices only the fee (the nightly run, the Billing
   * Events projection, promotion apply/revoke) needs no granted Sellable Items to
   * ask the question.
   */
  promotions: AppliedPromotionForBilling[];
}

export interface BillingSimulationInput {
  assignments: SimulationAssignment[];
  /** Overrides MAX_SIMULATION_MONTHS — tests only. */
  maxMonths?: number;
}

/** Why an actual charge differs from the regular price. */
export interface SimulationBenefit {
  /**
   * `promotion` — an applied Promotion. `membership_plan` (#635 stage 8) — the
   * assignment's own Billing & Duration, whose Free Period and Bonus Duration
   * waive the Membership Fee. A plan-sourced benefit carries no `name`: the
   * line it sits on already names the Plan (`plan_name`).
   */
  source: 'promotion' | 'membership_plan';
  name: string | null;
  /** `included` = the item itself is granted by the Promotion (session/one-off/periodical benefit). */
  action: PromotionBenefitAction | 'included';
  value: number | null;
  /**
   * Which period the charge fell in — only set for Membership Fee lines. A
   * Promotion's own timeline (`free_promotion`, …) for a promotion-sourced
   * benefit, the Plan's (`free_plan`, …) for a plan-sourced one.
   */
  period_status: PromotionTimelineStatus | PlanDurationStatus | null;
}

export interface SimulationLine {
  kind: 'membership_fee' | 'sellable_item';
  label: string;
  user_membership_id: number;
  plan_name: string | null;
  gym_charge_id: number | null;
  quantity: number;
  unit_price: number;
  regular_price: number;
  benefits: SimulationBenefit[];
  actual_charge: number;
  /**
   * #629 thread Q3: an event that falls a year or more after the item started
   * being billed is marked, because an annual price revision could change it.
   */
  price_may_change: boolean;
}

export interface SimulationEvent {
  date: string;
  /** Closing date of the billed period — only for range cadences (4-week, weekly). */
  period_end: string | null;
  lines: SimulationLine[];
  total: number;
}

export interface SimulationSectionResult {
  section: SimulationSection;
  events: SimulationEvent[];
  total: number;
}

export interface BillingSimulationResult {
  available: boolean;
  reason: string | null;
  currency: 'EUR';
  start_date: string | null;
  /** Last date the simulation runs to — the latest "first regular charge" across every item. */
  horizon_date: string | null;
  /** True when an item never reached its regular price within the safety cap. */
  truncated: boolean;
  sections: SimulationSectionResult[];
  total: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function dayBefore(dateStr: string): string {
  return advanceBillingDate(dateStr, -1, 'day');
}

function maxDate(a: string, b: string): string { return a > b ? a : b; }
function minDate(a: string, b: string): string { return a < b ? a : b; }

/* ── Cadences ────────────────────────────────────────────────────────────── */

/** One billing cadence, normalized so streams of either origin advance identically. */
interface Cadence {
  section: SimulationSection;
  /** Whether the section shows a period range (`01/10 → 28/10`) rather than a single date. */
  ranged: boolean;
  advance: (date: string) => string;
}

/** The Plan's `billing_policies` (interval, unit) pair. */
export function cadenceForBillingPolicy(interval: number, unit: BillingUnit): Cadence {
  const advance = (date: string) => advanceBillingDate(date, interval, unit);
  if (unit === 'year') return { section: 'year', ranged: false, advance };
  if (unit === 'month') return { section: 'month', ranged: false, advance };
  if (unit === 'week') {
    if (interval === 4) return { section: 'four_weeks', ranged: true, advance };
    if (interval === 1) return { section: 'week', ranged: true, advance };
  }
  if (unit === 'day') {
    if (interval === 28) return { section: 'four_weeks', ranged: true, advance };
    if (interval === 7) return { section: 'week', ranged: true, advance };
  }
  return { section: 'other', ranged: false, advance };
}

/** A Sellable Item's own `billing_frequency` — the ticket's "existing billing rules" for services. */
export function cadenceForSellableItem(frequency: SellableItemFrequency): Cadence | null {
  switch (frequency) {
    case 'year': return { section: 'year', ranged: false, advance: (d) => advanceBillingDate(d, 1, 'year') };
    case 'month': return { section: 'month', ranged: false, advance: (d) => advanceBillingDate(d, 1, 'month') };
    // 4-week billing is 28 days — never approximated as a month (#634 §10).
    case 'four_weeks': return { section: 'four_weeks', ranged: true, advance: (d) => advanceBillingDate(d, 28, 'day') };
    case 'week': return { section: 'week', ranged: true, advance: (d) => advanceBillingDate(d, 7, 'day') };
    default: return null; // 'once' / 'per_session' have no schedule to project
  }
}

/* ── Promotion resolution ────────────────────────────────────────────────── */

// The timeline depends only on the Promotion, but it is consulted once per
// projected charge — cached so a long projection doesn't rebuild it hundreds
// of times. Keyed on the request-scoped promotion object, so nothing is
// retained between requests.
const timelineCache = new WeakMap<AppliedPromotionForBilling, ReturnType<typeof computePromotionTimeline>>();

/**
 * Which Promotion period (#629 §5: Free / Prepaid / Pay / Bonus / Regular)
 * a date falls in, plus the Membership Fee Benefit in force for it.
 *
 * Delegates to `computePromotionTimeline` — the same projection the Promotion
 * screen renders — rather than re-deriving the period boundaries here, so the
 * simulation and the Promotion's own forecast can never disagree.
 */
function classifyPromotionPeriod(promo: AppliedPromotionForBilling, date: string): {
  status: PromotionTimelineStatus;
  billingAction: PromotionBenefitAction | null;
  billingValue: number | null;
} {
  const { periods } = timelineCache.get(promo) ?? cachePromotionTimeline(promo);

  for (const p of periods) {
    if (date >= p.startsOn && (p.endsOn == null || date <= p.endsOn)) {
      return { status: p.status, billingAction: p.billingAction, billingValue: p.billingValue };
    }
  }
  // Before the first period (the promotion was applied later than this date)
  // never happens — promotionCoversDate() already excluded it.
  return { status: 'pay_regular', billingAction: null, billingValue: null };
}

function cachePromotionTimeline(promo: AppliedPromotionForBilling) {
  // #635 stage 5: a Promotion has at most one Membership Fee Benefit, so the
  // timeline reads the first (and normally only) entry — the array shape is
  // kept for legacy snapshots, which could carry a second one.
  const membershipFeeBenefit: MembershipFeeBenefit | undefined = promo.membershipFeeBenefits[0];
  const timeline = computePromotionTimeline({
    freeMonths: promo.freeMonths,
    paidMonths: promo.paidMonths,
    payBeforehandMonths: promo.payBeforehandMonths,
    bonusMonths: promo.bonusMonths,
    membershipFeeAction: membershipFeeBenefit?.action ?? undefined,
    membershipFeeValue: membershipFeeBenefit?.value ?? null,
    membershipFeeEnabled: membershipFeeBenefit?.enabled ?? false,
    membershipFeeDurationMonths: membershipFeeBenefit?.durationMonths ?? null,
  }, promo.appliedAt);
  timelineCache.set(promo, timeline);
  return timeline;
}

/**
 * Resolves the Membership Fee actually charged on `date`, from the two things
 * that can change it: the applied Promotions and — since #635 stage 8 — the
 * assignment's own Billing & Duration.
 *
 * **The Promotion wins.** Where a Promotion governs the date (it is inside its
 * own Free/Paid/Bonus timeline, or it applies a Membership Fee Benefit there),
 * it decides the fee alone and the Plan's own Free/Bonus period does not also
 * apply — the #635 thread's Q2 answer, "in case of conflict, prioritize the
 * promotion". Stacking them would waive a fee twice (harmless) but would also
 * let a Promotion's *paid* month be overridden by the Plan's free one, which
 * inverts the answer.
 *
 * Where no Promotion governs the date, the Plan's own Free Period and Bonus
 * Duration waive the fee, exactly as a Promotion's do (§7: "the same semantics
 * as the Promotion configuration"), and since stage 13 so does a **Pre-paid**
 * month — one of the Paid Duration's months that was already paid up front, so
 * the cycle charges nothing further and the line reads "pre-paid" rather than
 * "free" (the two are told apart by the benefit's `period_status`, which is
 * what the simulation labels). Its Paid Duration bills the regular price
 * and produces no benefit line at all — it *is* the regular charge, so the
 * horizon (#629 §6: project until each item has been charged once at its
 * regular price) stops there, unless a Bonus Duration is still ahead of it: a
 * plan that gives two free months after twelve paid ones would otherwise never
 * show them, and a member is entitled to see the free months they were sold.
 *
 * Exported since #635 stage 11: the nightly billing run prices the cycle it is
 * about to charge through this same function, so what is charged cannot drift
 * from what the simulation — and the Member's own My Membership page — shows.
 */
export function resolveMembershipFee(regular: number, date: string, a: MembershipFeeContext): ResolvedCharge {
  const fromPromotions = resolvePromotionMembershipFee(regular, date, a.promotions);
  if (fromPromotions.promotional || fromPromotions.benefits.length > 0) return fromPromotions;

  const status = classifyPlanDurationPeriod(a.planDuration, a.startsAt, date);
  if (status === 'pay_regular') return fromPromotions;
  if (!planDurationWaivesFee(status)) {
    // Inside the Paid Duration: the regular amount either way, so this only
    // decides whether the projection may stop here — it may not while a Bonus
    // Duration behind it still has to be shown.
    return a.planDuration.bonusMonths > 0 ? { ...fromPromotions, promotional: true } : fromPromotions;
  }
  return {
    amount: 0,
    benefits: [{ source: 'membership_plan', name: null, action: 'waive', value: null, period_status: status }],
    promotional: true,
    pending: fromPromotions.pending,
  };
}

/**
 * The Promotion half of `resolveMembershipFee`.
 *
 * Free and Bonus promotional periods waive the fee outright; Pay/Prepaid
 * periods apply the Promotion's Membership Fee Benefit — and nothing applies
 * outside the Promotion's own Free/Paid/Bonus timeline, which is what *ends*
 * the benefit (#635 stage 12, the thread's answer (a)). A Promotion configured
 * with no months at all therefore changes no cycle: its timeline is a single
 * open-ended Pay (regular) period, and `effectiveBenefitDurationMonths` (#625)
 * caps the benefit at free + paid + bonus = 0.
 *
 * Since stage 12 this is the *only* implementation of that rule: the Billing
 * Events projection (`computeMembershipFeePriceAt`), `priceMembershipFeeOn()`, the
 * nightly run and the Member's own My Membership page all resolve a date
 * through here, so none of them can answer a different price for the same
 * cycle.
 */
function resolvePromotionMembershipFee(regular: number, date: string, promotions: AppliedPromotionForBilling[]): ResolvedCharge {
  let amount = regular;
  const benefits: SimulationBenefit[] = [];
  // A paid promotional period with no Membership Fee Benefit charges the
  // regular price but is still *inside* the promotion, so it is not the
  // "first regular billing milestone" the horizon stops at (#629 §6).
  let promotional = false;

  for (const promo of promotions) {
    if (!promotionCoversDate(promo, date)) continue;
    const { status, billingAction, billingValue } = classifyPromotionPeriod(promo, date);
    if (status !== 'pay_regular') promotional = true;

    if (status === 'free_promotion' || status === 'bonus_promotion') {
      amount = 0;
      benefits.push({ source: 'promotion', name: promo.name ?? null, action: 'waive', value: null, period_status: status });
    } else if (billingAction != null && billingAction !== 'no_benefit') {
      amount = applyPeriodBenefit(amount, billingAction, billingValue);
      benefits.push({ source: 'promotion', name: promo.name ?? null, action: billingAction, value: billingValue, period_status: status });
    }

    // The Promotion's own Membership Fee Benefit is already part of its
    // timeline (see cachePromotionTimeline), so only the *extra* entries a
    // pre-#635-stage-5 snapshot can carry are applied on top — a legacy
    // Charge Benefit on the membership fee, which applied for as long as the
    // promotion did and stacked with the Period Benefit. Nothing written
    // since stage 5 has more than one entry, so this loop is empty there.
    for (const b of promo.membershipFeeBenefits.slice(1)) {
      if (!b.enabled || b.action == null || b.action === 'no_benefit') continue;
      amount = applyPeriodBenefit(amount, b.action, b.value);
      benefits.push({ source: 'promotion', name: promo.name ?? null, action: b.action, value: b.value, period_status: status });
      promotional = true;
    }
  }

  const pending = promotions.some((p) => date < p.appliedAt && hasPromotionalEffect(p));
  return { amount: round2(amount), benefits, promotional, pending };
}

/** Does this Promotion change the Membership Fee at all, in any period? */
function hasPromotionalEffect(promo: AppliedPromotionForBilling): boolean {
  return promo.freeMonths + promo.paidMonths + promo.bonusMonths > 0
    || promo.membershipFeeBenefits.length > 0;
}

/* ── Streams ─────────────────────────────────────────────────────────────── */

/**
 * One projected charge: what is owed, why it differs from the regular price,
 * and whether a Promotion still governs it (which is not the same thing — a
 * paid promotional period can charge the regular price).
 */
export interface ResolvedCharge {
  amount: number;
  benefits: SimulationBenefit[];
  /**
   * The charge is still inside a configured window — an applied Promotion's
   * timeline, or (since #635 stage 8) the assignment's own Billing & Duration —
   * so it is not the "first regular billing milestone" the horizon stops at,
   * whatever amount it carries.
   */
  promotional: boolean;
  /**
   * A Promotion has yet to start affecting this item — it was applied after
   * the item began being billed. Such a charge is at the regular price but is
   * not the "first regular billing milestone": the promotional charges are
   * still ahead of it.
   */
  pending: boolean;
}

/**
 * One billable item projected over time. Every item — the Membership Fee and
 * each granted Sellable Item alike — is a stream, so the horizon rule (#629
 * §6: run until every item has shown one regular charge) is applied once.
 */
interface Stream {
  cadence: Cadence;
  section: SimulationSection;
  start: string;
  end: string | null;
  /** Amount + explanation for the n-th occurrence (0-based) on `date`. */
  resolve: (date: string, occurrence: number) => ResolvedCharge;
  line: (date: string, resolved: ResolvedCharge) => SimulationLine;
}

/**
 * Index of the first occurrence of `cadence` (counted from `start`) that falls
 * on or after `from`. Bounded so a cadence that fails to advance can't spin.
 */
function occurrenceIndexOf(start: string, from: string, cadence: Cadence): number {
  let cursor = start;
  let index = 0;
  while (cursor < from && index < MAX_OCCURRENCE_SCAN) {
    const next = cadence.advance(cursor);
    if (next <= cursor) break;
    cursor = next;
    index++;
  }
  return index;
}

/** A non-recurring charge: one line, on the assignment's start date. */
interface SingleCharge {
  section: SimulationSection;
  date: string;
  line: SimulationLine;
}

function buildMembershipFeeStream(a: SimulationAssignment): Stream | null {
  if (a.membershipFeePrice == null || a.recurringInterval == null || a.recurringUnit == null) return null;
  const regular = round2(a.membershipFeePrice);
  const cadence = cadenceForBillingPolicy(a.recurringInterval, a.recurringUnit);
  return {
    cadence,
    section: cadence.section,
    start: a.startsAt,
    end: a.endsAt,
    resolve: (date) => resolveMembershipFee(regular, date, a),
    line: (date, resolved) => ({
      kind: 'membership_fee',
      label: a.planName ?? 'Membership Fee',
      user_membership_id: a.userMembershipId,
      plan_name: a.planName,
      gym_charge_id: null,
      quantity: 1,
      unit_price: regular,
      regular_price: regular,
      benefits: resolved.benefits,
      actual_charge: resolved.amount,
      price_may_change: date >= advanceBillingDate(a.startsAt, 1, 'year'),
    }),
  };
}

/* ── Billable Sellable Items ─────────────────────────────────────────────── */

/** One Promotion grant, kept with the Promotion that granted it. */
interface GrantCoverage {
  promo: SimulationPromotion;
  grant: SimulationGrant;
}

/**
 * One Sellable Item the assignment bills, with every Promotion grant that
 * covers it. Merging on `gymChargeId` is what keeps a Plan's Period Benefit
 * and a Promotion granting the same item one charge — the Promotion covers
 * periods of it rather than adding a second locker.
 */
interface BillableItem {
  gymChargeId: number;
  name: string;
  category: SellableItemBenefitCategory;
  billingFrequency: SellableItemFrequency | null;
  unitPrice: number;
  /** Units billed each occurrence (Period Benefit) or once (one-off/session). */
  quantity: number;
  coverage: GrantCoverage[];
}

/**
 * The Plan's own benefits plus everything the applied Promotions grant, keyed
 * by Sellable Item.
 *
 * An item the Plan does not carry behaves exactly as it did before #635 stage
 * 3: quantity 1 for a periodical grant (the grant covers periods, it does not
 * say how many lockers) and the granted quantity for a one-off/session grant,
 * charged at 0 for as long as the grant covers it.
 */
function collectBillableItems(a: SimulationAssignment): BillableItem[] {
  const byCharge = new Map<string, BillableItem>();
  // A snapshotted grant whose Sellable Item has since been deleted carries no
  // id (0). Those never merge with each other — two forgotten items are still
  // two items — so each takes a key of its own.
  let orphan = 0;
  const keyOf = (gymChargeId: number) => (gymChargeId > 0 ? `item:${gymChargeId}` : `orphan:${orphan++}`);

  for (const benefit of a.planBenefits) {
    byCharge.set(keyOf(benefit.gymChargeId), {
      gymChargeId: benefit.gymChargeId,
      name: benefit.name,
      category: benefit.category,
      billingFrequency: benefit.billingFrequency,
      unitPrice: benefit.unitPrice,
      quantity: Math.max(1, Math.trunc(benefit.quantity) || 1),
      coverage: [],
    });
  }

  for (const promo of a.promotions) {
    for (const grant of promo.grants) {
      const existing = grant.gymChargeId > 0 ? byCharge.get(`item:${grant.gymChargeId}`) : undefined;
      if (existing) {
        existing.coverage.push({ promo, grant });
        continue;
      }
      byCharge.set(keyOf(grant.gymChargeId), {
        gymChargeId: grant.gymChargeId,
        name: grant.name,
        category: grant.category,
        billingFrequency: grant.billingFrequency,
        unitPrice: grant.unitPrice,
        quantity: grant.category === 'periodical' ? 1 : Math.max(1, Math.trunc(grant.quantity) || 1),
        coverage: [{ promo, grant }],
      });
    }
  }

  return [...byCharge.values()];
}

/**
 * A recurring Sellable Item: billed at its own `billing_frequency` from the
 * assignment's start date, waived for the periods a Promotion grant covers and
 * charged at its regular price otherwise (#629 thread Q3, #635 §14).
 */
function buildItemStream(a: SimulationAssignment, item: BillableItem): Stream | null {
  const cadence = item.billingFrequency ? cadenceForSellableItem(item.billingFrequency) : null;
  if (!cadence) return null;
  const unit = round2(item.unitPrice);
  const regular = round2(unit * item.quantity);
  // The item is billed from the assignment's start date, but a grant only
  // starts covering periods once its Promotion was applied — which can be
  // later. Counting the granted periods from the first *covered* occurrence
  // keeps a Promotion applied mid-assignment worth its full quantity.
  const coverage = item.coverage.map((c) => ({
    ...c,
    firstCovered: occurrenceIndexOf(a.startsAt, c.promo.appliedAt, cadence),
  }));
  return {
    cadence,
    section: cadence.section,
    start: a.startsAt,
    end: a.endsAt,
    resolve: (date, occurrence) => {
      const covering = coverage.filter((c) => occurrence >= c.firstCovered
        && occurrence < c.firstCovered + c.grant.quantity
        && promotionCoversDate(c.promo, date));
      if (covering.length > 0) {
        return {
          amount: 0,
          benefits: covering.map((c) => ({
            source: 'promotion' as const, name: c.promo.name,
            action: 'included' as const, value: null, period_status: null,
          })),
          promotional: true,
          pending: false,
        };
      }
      const pending = coverage.some((c) => occurrence < c.firstCovered
        && (c.promo.revokedAt == null || date <= c.promo.revokedAt));
      return { amount: regular, benefits: [], promotional: false, pending };
    },
    line: (date, resolved) => ({
      kind: 'sellable_item',
      label: item.name,
      user_membership_id: a.userMembershipId,
      plan_name: a.planName,
      gym_charge_id: item.gymChargeId > 0 ? item.gymChargeId : null,
      quantity: item.quantity,
      unit_price: unit,
      regular_price: regular,
      benefits: resolved.benefits,
      actual_charge: resolved.amount,
      price_may_change: date >= advanceBillingDate(a.startsAt, 1, 'year'),
    }),
  };
}

/**
 * #631 — an Additional Periodic Service.
 *
 * Billed at the Sellable Item's own cadence and price, from the later of the
 * assignment's start and the service's effective start date (#631 §5: a
 * service added after the plan started bills from its actual effective date),
 * and until the earlier of the assignment's end and the service's effective
 * removal date (#631 §3: removal affects future billing only — charges before
 * `endsOn` still stand).
 *
 * No Promotion resolution: these are additional services, never Promotion
 * benefits (#631 §7), so every occurrence is charged at the regular price and
 * carries no benefit explanation.
 */
function buildServiceStream(a: SimulationAssignment, service: SimulationService): Stream | null {
  const cadence = service.billingFrequency ? cadenceForSellableItem(service.billingFrequency) : null;
  if (!cadence) return null;

  const start = maxDate(a.startsAt, service.startsOn);
  const end = a.endsAt != null && service.endsOn != null
    ? minDate(a.endsAt, service.endsOn)
    : (a.endsAt ?? service.endsOn);
  if (end != null && end < start) return null;

  const quantity = Math.max(1, Math.trunc(service.quantity) || 1);
  const unit = round2(service.unitPrice);
  const regular = round2(unit * quantity);
  return {
    cadence,
    section: cadence.section,
    start,
    end,
    resolve: () => ({ amount: regular, benefits: [], promotional: false, pending: false }),
    line: (date) => ({
      kind: 'sellable_item',
      label: service.name,
      user_membership_id: a.userMembershipId,
      plan_name: a.planName,
      gym_charge_id: service.gymChargeId,
      quantity,
      unit_price: unit,
      regular_price: regular,
      benefits: [],
      actual_charge: regular,
      price_may_change: date >= advanceBillingDate(start, 1, 'year'),
    }),
  };
}

/**
 * A one-off or session item: no schedule to project, so it is a single line on
 * the assignment's start date covering the whole quantity (#629 thread Q5 —
 * `per_session` items appear as "N sessions").
 *
 * The Promotion grants covering it pay for as many units as they grant, capped
 * at the quantity actually billed: a Plan carrying 10 sessions and a Promotion
 * granting 4 of them charges the remaining 6, while an item the Plan does not
 * carry at all is granted in full and charges nothing.
 */
function buildItemSingleCharge(a: SimulationAssignment, item: BillableItem): SingleCharge {
  const unit = round2(item.unitPrice);
  const regular = round2(unit * item.quantity);
  const granted = item.coverage.reduce((sum, c) => sum + Math.max(0, Math.trunc(c.grant.quantity) || 0), 0);
  const covered = Math.min(item.quantity, granted);
  return {
    section: item.category === 'session' ? 'session' : 'one_off',
    date: a.startsAt,
    line: {
      kind: 'sellable_item',
      label: item.name,
      user_membership_id: a.userMembershipId,
      plan_name: a.planName,
      gym_charge_id: item.gymChargeId > 0 ? item.gymChargeId : null,
      quantity: item.quantity,
      unit_price: unit,
      regular_price: regular,
      benefits: covered > 0
        ? item.coverage.map((c) => ({
          source: 'promotion' as const, name: c.promo.name,
          action: 'included' as const, value: null, period_status: null,
        }))
        : [],
      actual_charge: round2(unit * (item.quantity - covered)),
      price_may_change: false,
    },
  };
}

/* ── Projection ──────────────────────────────────────────────────────────── */

interface GeneratedEvent {
  section: SimulationSection;
  date: string;
  period_end: string | null;
  line: SimulationLine;
}

/**
 * Walks one stream, yielding events, until `stopAt` decides to stop. Returns
 * whether the cap was hit before the caller's stop condition was met.
 */
function walkStream(
  stream: Stream,
  cap: string,
  stopAt: (date: string, resolved: ResolvedCharge) => boolean,
): { events: GeneratedEvent[]; capped: boolean } {
  const events: GeneratedEvent[] = [];
  let cursor = stream.start;
  let occurrence = 0;
  while (cursor <= cap) {
    if (stream.end != null && cursor > stream.end) return { events, capped: false };
    const resolved = stream.resolve(cursor, occurrence);
    const next = stream.cadence.advance(cursor);
    events.push({
      section: stream.section,
      date: cursor,
      period_end: stream.cadence.ranged ? dayBefore(next) : null,
      line: stream.line(cursor, resolved),
    });
    if (stopAt(cursor, resolved)) return { events, capped: false };
    // A cadence that doesn't advance would loop forever — treat as capped.
    if (next <= cursor) return { events, capped: true };
    cursor = next;
    occurrence++;
  }
  return { events, capped: true };
}

/**
 * The #629 §6 / thread-Q3 horizon: every item is projected until it has been
 * charged once at its regular price, and the whole simulation then runs to the
 * latest of those dates, so a yearly item pushes the monthly ones out with it.
 */
export function computeBillingSimulation(input: BillingSimulationInput): BillingSimulationResult {
  const assignments = input.assignments;
  const empty: BillingSimulationResult = {
    available: false, reason: null, currency: 'EUR',
    start_date: null, horizon_date: null, truncated: false, sections: [], total: 0,
  };

  if (assignments.length === 0) {
    return { ...empty, reason: 'No active Membership Plans to simulate.' };
  }

  const streams: Stream[] = [];
  const singles: SingleCharge[] = [];
  for (const a of assignments) {
    const fee = buildMembershipFeeStream(a);
    if (fee) streams.push(fee);
    for (const item of collectBillableItems(a)) {
      if (item.category === 'periodical') {
        const s = buildItemStream(a, item);
        if (s) streams.push(s);
      } else {
        singles.push(buildItemSingleCharge(a, item));
      }
    }
    for (const service of a.services) {
      const s = buildServiceStream(a, service);
      if (s) streams.push(s);
    }
  }

  if (streams.length === 0 && singles.length === 0) {
    return {
      ...empty,
      reason: 'Configure a plan price and billing frequency to preview the billing simulation.',
    };
  }

  const startDate = [
    ...streams.map((s) => s.start),
    ...singles.map((s) => s.date),
  ].reduce(minDate);
  const cap = advanceBillingDate(startDate, input.maxMonths ?? MAX_SIMULATION_MONTHS, 'month');

  // Pass 1 — each stream's own first regular (unbenefited) charge.
  let horizon = startDate;
  let truncated = false;
  for (const stream of streams) {
    const { events, capped } = walkStream(stream, cap, (_d, r) => !r.promotional && !r.pending);
    if (capped) truncated = true;
    const last = events[events.length - 1];
    if (last) horizon = maxDate(horizon, last.date);
  }

  // Pass 2 — every stream now runs to the shared horizon.
  const generated: GeneratedEvent[] = [];
  for (const stream of streams) {
    const stop = stream.end != null ? minDate(horizon, stream.end) : horizon;
    const { events } = walkStream(stream, minDate(stop, cap), (d) => d >= stop);
    generated.push(...events.filter((e) => e.date <= stop));
  }
  for (const single of singles) {
    generated.push({ section: single.section, date: single.date, period_end: null, line: single.line });
  }

  const sections: SimulationSectionResult[] = [];
  for (const section of SECTION_ORDER) {
    const inSection = generated.filter((e) => e.section === section);
    if (inSection.length === 0) continue;

    const byDate = new Map<string, SimulationEvent>();
    for (const e of inSection) {
      const key = `${e.date}|${e.period_end ?? ''}`;
      let event = byDate.get(key);
      if (!event) {
        event = { date: e.date, period_end: e.period_end, lines: [], total: 0 };
        byDate.set(key, event);
      }
      event.lines.push(e.line);
    }
    const events = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const event of events) event.total = round2(event.lines.reduce((sum, l) => sum + l.actual_charge, 0));
    sections.push({ section, events, total: round2(events.reduce((sum, e) => sum + e.total, 0)) });
  }

  return {
    available: true,
    reason: null,
    currency: 'EUR',
    start_date: startDate,
    horizon_date: horizon,
    truncated,
    sections,
    total: round2(sections.reduce((sum, s) => sum + s.total, 0)),
  };
}
