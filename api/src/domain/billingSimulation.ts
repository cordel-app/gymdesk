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
// #631 adds Additional Periodic Services: recurring Products attached
// directly to an assignment. They are plain items on the assignment, not
// Promotion benefits (#631 §7) — each is its own stream, billed at the
// Product's own frequency and price over its own effective window, so
// the horizon rule below covers them exactly as it covers everything else.
//
// #635 stage 3 adds the Assigned Plan's own benefit sections (One-off /
// Session / Period Benefits, frozen onto the assignment at assignment time).
// They are *charged* items, not free ones: the Plan says the member gets a
// locker, the member pays the frozen price for it, and a Promotion granting
// the same Product is what makes a period free. A Plan item and the
// Promotion grants covering it are therefore merged into one stream per
// Product — two independent streams would bill the locker twice.
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
//
// #772 adds the one thing in here that is *not* bounded in time: the Assigned
// Plan's own Personal Membership Fee Benefit, applied on top of whatever the
// Promotions and the Billing & Duration resolve, on every cycle for the whole
// life of the assignment.
//
// #896 stage 3 makes the Product half of that explicit. A Plan benefit
// and a Promotion grant each carry their own `(action, value)` pair now
// (migration 203), so "the Plan charges for it and the Promotion makes it
// free" stops being hard-coded and becomes the `no_benefit` / `waive` case of
// one rule, applied through `applyLineBenefit()` / `applyPeriodBenefit()` —
// §11's "do not introduce a second independent pricing system". Every row that
// predates the column reads what it already meant (`waive` on the Promotion
// side, `no_benefit` on the Plan side), so no existing configuration changes
// price by a cent.

import { advanceBillingDate } from './billingDate';
import {
  PlanDuration,
  PlanDurationStatus,
  classifyPlanDurationPeriod,
  planDurationWaivesFee,
  prepaidPeriodsDueOn,
} from './planDuration';
import {
  PersonalFeeBenefit,
  applyPersonalFeeBenefit,
  personalFeeBenefitApplies,
} from './personalFeeBenefit';
import { applyPeriodBenefit, PromotionBenefitAction } from './promotionBenefits';
import {
  NO_PRODUCT_BENEFIT,
  ProductBenefit,
  applyLineBenefit,
} from './productBenefitActions';
import {
  AppliedPromotionForBilling,
  MembershipFeeBenefit,
  promotionCoversDate,
} from './promotionApplication';
import {
  PromotionTimelineStatus,
  computePromotionTimeline,
} from './promotionTimeline';
import { ProductBenefitCategory } from './productClassification';
import {
  SessionBenefitFrequency,
  isRenewingSessionFrequency,
  renewalsInPeriod,
} from './sessionBenefitFrequency';

export type BillingUnit = 'day' | 'week' | 'month' | 'year';

/** `gym_charges.billing_frequency` (migrations 090/102/123). */
export type ProductFrequency = 'once' | 'per_session' | 'week' | 'four_weeks' | 'month' | 'year';

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
// otherwise never terminate.
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
  /** Products granted by this Promotion (`promotion_session` / `_oneoff` / `_periodical`). */
  grants: SimulationGrant[];
}

export interface SimulationGrant {
  gymChargeId: number;
  name: string;
  category: ProductBenefitCategory;
  billingFrequency: ProductFrequency | null;
  unitPrice: number;
  /**
   * What the Promotion grants: for a `session` or `oneoff` item the number of
   * units covered, for a `periodical` item the number of billing periods
   * covered (`promotion_periodical.quantity`).
   */
  quantity: number;
  /**
   * #896 stage 3 — what the grant *does* to the units it covers, which until
   * this stage was hard-coded: a grant made them free. It is now the
   * relationship's own `(action, value)` pair, read from the application's
   * snapshot (§16) and normalized through `toProductBenefit()`.
   *
   * Required rather than optional, for the reason `personalFeeBenefit` is: a
   * loader that forgot it would silently price a grant as `no_benefit` and
   * start charging a member for what their Promotion gives them. Every row
   * that predates the column reads `waive` (migration 203's backfill), so
   * nothing an existing member holds changes price here.
   */
  benefit: ProductBenefit;
}

/**
 * #631 — an Additional Periodic Service: a recurring Product attached to
 * the assignment itself. Billed at the item's own `billing_frequency` and
 * price, over the window it is attached for (`endsOn` is the effective removal
 * date, so removing a service only ever stops future charges).
 */
export interface SimulationService {
  id: number;
  gymChargeId: number;
  name: string;
  billingFrequency: ProductFrequency | null;
  unitPrice: number;
  quantity: number;
  startsOn: string;
  endsOn: string | null;
}

/**
 * #635 — a Product the Assigned Plan itself carries: a One-off, Session
 * or Period Benefit of the Membership Plan, copied onto the assignment when it
 * was created (`user_membership_oneoff` / `_session` / `_periodical`).
 *
 * Unlike a Promotion grant it is charged, at the price frozen with it: the
 * Plan decides the member gets a locker, not that the locker is free.
 */
export interface SimulationPlanBenefit {
  gymChargeId: number;
  name: string;
  category: ProductBenefitCategory;
  billingFrequency: ProductFrequency | null;
  unitPrice: number;
  /** Units billed — per period for a Period Benefit, once for the other two. */
  quantity: number;
  /**
   * #918 — a **Session** Benefit's own renewal Frequency ("2 sessions per
   * week"), frozen onto the assignment with the rest of the line. `null` and
   * `once` both mean the allowance is granted once, on the assignment's start
   * date, which is what every Session Benefit agreed before #918 means.
   *
   * Required rather than optional, for the reason `benefit` and
   * `personalFeeBenefit` are: it changes how many units the projection reports
   * on each billing date, so a loader that forgot it would quietly show a
   * member 2 sessions where their contract entitles them to 8. Not meaningful
   * for the other two categories, which carry `null`.
   */
  sessionFrequency: SessionBenefitFrequency | null;
  /**
   * #896 stage 3 — the Plan's own pricing treatment of this line, frozen onto
   * the assignment with it. `no_benefit` (the column default, and what every
   * row written before migration 203 reads as) is the normal price, which is
   * what a Plan benefit has always been charged at.
   *
   * Unlike a Promotion grant's, it is bounded by nothing: it is how this
   * contract prices the item for its whole life, so it never makes a charge
   * `promotional` — see `buildItemStream`.
   */
  benefit: ProductBenefit;
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
   * `startsAt`, not from any Promotion's application date, and — since #892 —
   * in periods of the assignment's own Billing Frequency, which the value
   * carries (`PlanDuration.cadence`).
   */
  planDuration: PlanDuration;
  /** #772 — the assignment's own Personal Membership Fee Benefit. */
  personalFeeBenefit: PersonalFeeBenefit;
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
   * Events projection, promotion apply/revoke) needs no granted Products to
   * ask the question.
   */
  promotions: AppliedPromotionForBilling[];
  /**
   * #772 — the assignment's own Personal Membership Fee Benefit. Unlike
   * everything else here it is bounded by nothing: it is applied on top of
   * whatever the Promotions and the Billing & Duration resolve, on every cycle
   * for the whole life of the assignment. Required rather than optional so a
   * new pricing path cannot silently forget it and charge a member the
   * undiscounted fee.
   */
  personalFeeBenefit: PersonalFeeBenefit;
}

export interface BillingSimulationInput {
  assignments: SimulationAssignment[];
  /** Overrides MAX_SIMULATION_MONTHS — tests only. */
  maxMonths?: number;
  /**
   * #915 — a floor on the projection's horizon, in complete cycles of *every*
   * recurring stream. The default rule (#629 §6) is "run until each item has
   * been charged once at its regular price", which for a configuration with no
   * Promotions at all is satisfied by the very first charge: a Plan billing a
   * flat €70 every 4 weeks would project one event and stop.
   *
   * The Membership Plan's own Billing Event Simulation needs a span instead —
   * "two complete cycles of every recurring billing frequency present in the
   * plan", so a yearly item stretches the projection to two years and drags the
   * 4-weekly ones along with it. `2` therefore means the horizon is at least
   * `stream.start + 2 x cadence`, which is two whole cycles of wall-clock time
   * and (because an event lands on the horizon itself) three charges of the
   * fastest stream — exactly the Sep 30 / Oct 28 / Nov 25 shape #915 specifies.
   *
   * It only ever *raises* the horizon: the first-regular-charge rule still
   * applies, so a Plan with a six-period Free Period keeps projecting until its
   * first paid period instead of stopping two cycles in. Bounded by the same
   * `cap` and by each stream's own end date.
   */
  minimumCycles?: number;
  /**
   * #924 stage 4 — the date the horizon (both the `minimumCycles` floor and the
   * safety cap) is measured from. Defaults to the earliest stream start, which
   * is what every hypothetical-assignment caller wants: a Plan or Promotion
   * preview starts today, so the two are the same date.
   *
   * An **existing** assignment is the case that needs it. Its streams are
   * anchored on the contract's real `starts_at`, so a projection of a member
   * who enrolled three years ago would measure both the floor and the 36-month
   * cap from 2023 and report an empty projection — every date it could name is
   * already in the past. Passing today here keeps the dates, the amounts and
   * the period statuses exactly as the engine computes them from `starts_at`
   * (nothing is re-anchored) and only extends how far forward it runs.
   */
  horizonFrom?: string;
}

/** Why an actual charge differs from the regular price. */
export interface SimulationBenefit {
  /**
   * `promotion` — an applied Promotion. `membership_plan` (#635 stage 8) — the
   * assignment's own Billing & Duration, whose Free Period and Bonus Duration
   * waive the Membership Fee. `personal` (#772) — the assignment's own
   * Personal Membership Fee Benefit, which belongs to the contract rather than
   * to any Promotion and so applies to every cycle. Neither of the latter two
   * carries a `name`: the line they sit on already names the Plan
   * (`plan_name`).
   */
  source: 'promotion' | 'membership_plan' | 'personal';
  name: string | null;
  /**
   * The treatment applied, in the one vocabulary both sides store
   * (`PromotionBenefitAction`).
   *
   * `included` is the pre-#896 spelling of "this Promotion grant made the item
   * free": until stage 3 a grant carried no action of its own, so the line had
   * nothing truer to report. A grant now reports the pair it is configured
   * with — `waive` for every row migration 203 backfilled, which is what
   * `included` always meant — so nothing writes `included` any more. The member
   * of the union stays because the admin still labels it and removing it is a
   * label change, not a pricing one.
   */
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
  /**
   * #946 — how many Pre-paid periods this charge covers, for the one line that
   * ever covers more than one: the Membership Fee collected up front on the
   * first period of a Plan's Pre-paid Duration ("3 periods prepaid"). `null`
   * everywhere else, which is every Product line and every ordinary
   * Membership Fee cycle.
   */
  prepaid_periods: number | null;
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

/** A Product's own `billing_frequency` — the ticket's "existing billing rules" for services. */
export function cadenceForProduct(frequency: ProductFrequency): Cadence | null {
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
  return withPersonalFeeBenefit(resolveAgreedMembershipFee(regular, date, a), a.personalFeeBenefit);
}

/** Everything that is bounded in time: the Promotions, then the Plan's own durations. */
function resolveAgreedMembershipFee(regular: number, date: string, a: MembershipFeeContext): ResolvedCharge {
  const fromPromotions = resolvePromotionMembershipFee(regular, date, a.promotions);
  // The governing Promotion decided the fee, so its own period is what this
  // cycle's status is — the Plan's Billing & Duration is not consulted at all.
  if (fromPromotions.promotional || fromPromotions.benefits.length > 0) return fromPromotions;

  const status = classifyPlanDurationPeriod(a.planDuration, a.startsAt, date);
  if (status === 'pay_regular') return { ...fromPromotions, periodStatus: status };
  if (!planDurationWaivesFee(status)) {
    // Inside the Paid Duration: the regular amount either way, so this only
    // decides whether the projection may stop here — it may not while a Bonus
    // Duration behind it still has to be shown.
    return a.planDuration.bonusPeriods > 0
      ? { ...fromPromotions, promotional: true, periodStatus: status }
      : { ...fromPromotions, periodStatus: status };
  }
  if (status === 'prepaid_plan') return resolvePrepaidMembershipFee(regular, date, a, fromPromotions);
  return {
    amount: 0,
    benefits: [{ source: 'membership_plan', name: null, action: 'waive', value: null, period_status: status }],
    promotional: true,
    pending: fromPromotions.pending,
    periodStatus: status,
  };
}

/**
 * #946 — the Pre-paid Duration, which is the one period of a Plan's Billing &
 * Duration that is **paid rather than waived**.
 *
 * "Pre-paid" says the member settles those periods up front, so the whole
 * duration is owed on the first of them (`prepaidPeriodsDueOn()`) and the
 * periods it covers charge nothing further. Before this ticket every prepaid
 * period resolved to 0 with a `waive` benefit, which showed the gym
 * `Waived · €0.00` where it had sold `€210`, and left a prepaid Plan unable to
 * take a first payment at all (`POST /payment-requests` refuses a cycle that
 * owes nothing, so no card was ever stored and the nightly run skipped the
 * assignment for ever).
 *
 * Three properties are the rule here:
 *
 *   - The amount is `regular x periods`, and because
 *     `withPersonalFeeBenefit()` is applied to whatever this returns, a
 *     Personal Membership Fee Benefit discounts every period the lump covers
 *     rather than one of them. An applied Promotion governing the date never
 *     reaches here at all — it decides the fee alone (#635's Q2 answer), so the
 *     prepaid lump is the un-promoted regular fee by construction.
 *   - It carries **no benefit line**: it is a real payment at the regular price
 *     for `periods` periods, and reporting a `waive` is what made the
 *     simulation claim the member pays nothing. The line reports the count
 *     instead (`prepaid_periods`), which is what lets the admin say
 *     "3 periods prepaid" beside it.
 *   - It stays `promotional` in the horizon's sense (#629 §6). The lump is not
 *     this contract's recurring regular charge, so the projection keeps running
 *     until the first ordinary one — otherwise a Plan with a Pre-paid Duration
 *     would stop at its own first event and never show the fee resuming, which
 *     is the ticket's own acceptance criterion.
 *
 * A covered period answers `quantity: 0`, which is `walkStream()`'s existing
 * "this occurrence is not a billing event" (#918): no Membership Fee event is
 * generated for a period the first charge already paid for. It keeps the
 * `waive` benefit and its `prepaid_plan` period status, so every path that
 * prices one date at a time — `priceMembershipFeeOn()`, and through it the
 * nightly run's `waived_billing` branch and My Membership — behaves exactly as
 * it did.
 */
function resolvePrepaidMembershipFee(
  regular: number, date: string, a: MembershipFeeContext, fromPromotions: ResolvedCharge,
): ResolvedCharge {
  const periods = prepaidPeriodsDueOn(a.planDuration, a.startsAt, date);
  if (periods > 0) {
    return {
      amount: round2(regular * periods),
      benefits: [],
      promotional: true,
      pending: fromPromotions.pending,
      periodStatus: 'prepaid_plan',
      prepaidPeriods: periods,
    };
  }
  return {
    amount: 0,
    quantity: 0,
    benefits: [{
      source: 'membership_plan', name: null, action: 'waive', value: null, period_status: 'prepaid_plan',
    }],
    promotional: true,
    pending: fromPromotions.pending,
    periodStatus: 'prepaid_plan',
  };
}

/**
 * #772 — the Personal Membership Fee Benefit, applied **last and always**.
 *
 * The ticket fixes both halves of that. *Last*, because it is applied "on top
 * of the resolved Membership Fee": the Promotions and the Billing & Duration
 * decide what the cycle costs, and this discounts that number. *Always*,
 * because it belongs to the Assigned Plan rather than to any Promotion and
 * "must not expire when a Promotion ends" — so unlike a Promotion's own
 * Membership Fee Benefit there is no window to be inside, and unlike the Plan's
 * Free Period there is nothing for a governing Promotion to outrank. The two
 * stack: a cycle inside a Promotion that halves the fee, on an assignment with
 * a personal 10% off, pays 45% of the regular price.
 *
 * It deliberately does **not** set `promotional`. That flag is the projection's
 * horizon (#629 §6: run until every item has shown one charge at its regular
 * price), and a benefit that never ends would push the horizon to
 * `MAX_SIMULATION_MONTHS` for every discounted assignment. A cycle whose only
 * benefit is the personal one *is* this contract's regular charge.
 */
function withPersonalFeeBenefit(resolved: ResolvedCharge, benefit: PersonalFeeBenefit): ResolvedCharge {
  if (!personalFeeBenefitApplies(benefit)) return resolved;
  return {
    ...resolved,
    amount: applyPersonalFeeBenefit(resolved.amount, benefit),
    benefits: [
      ...resolved.benefits,
      { source: 'personal', name: null, action: benefit.action, value: benefit.value, period_status: null },
    ],
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
 * Simulation, `priceMembershipFeeOn()` (and through it the nightly run), the
 * Promotion apply/revoke adjustment and the Member's own My Membership page all
 * resolve a date through here, so none of them can answer a different price for
 * the same cycle.
 */
function resolvePromotionMembershipFee(regular: number, date: string, promotions: AppliedPromotionForBilling[]): ResolvedCharge {
  let amount = regular;
  const benefits: SimulationBenefit[] = [];
  // A paid promotional period with no Membership Fee Benefit charges the
  // regular price but is still *inside* the promotion, so it is not the
  // "first regular billing milestone" the horizon stops at (#629 §6).
  let promotional = false;
  // #924 stage 3 — which promotional period the caller is being charged for.
  // The last covering Promotion wins, exactly as the amount above does: the
  // loop folds them in order, so the status reported is the one that decided
  // the number beside it.
  let periodStatus: PromotionTimelineStatus | undefined;

  for (const promo of promotions) {
    if (!promotionCoversDate(promo, date)) continue;
    const { status, billingAction, billingValue } = classifyPromotionPeriod(promo, date);
    if (status !== 'pay_regular') {
      promotional = true;
      periodStatus = status;
    }

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
  return { amount: round2(amount), benefits, promotional, pending, periodStatus };
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
  /**
   * #918 — how many units this occurrence covers, for the one stream whose
   * quantity is not the same every time: a Session Benefit's renewing
   * allowance grants `quantity x renewals in this billing cycle`, which on
   * monthly billing is 5 weeks in one cycle and 4 in the next.
   *
   * Absent on every other stream, which bills the item's own quantity each
   * time. `0` means the cycle contains no renewal at all — `walkStream()`
   * emits no event for it, because an allowance of nothing is not a billing
   * event. #946 is the Membership Fee's own use of that `0`: a prepaid period
   * the first charge already covers generates no billing event.
   */
  quantity?: number;
  /**
   * Which configured period decided this charge — the governing Promotion's
   * (`free_promotion`, `pay_promotion`, …) when one governs the date, else the
   * assignment's own Billing & Duration (`free_plan`, `prepaid_plan`, …).
   *
   * It is reported rather than re-derived because the precedence between the
   * two is this function's alone (#635's Q2 answer: where a Promotion governs
   * the date it decides the fee *alone*). A caller that classified the period
   * itself would label a cycle `free_plan` that the governing Promotion is in
   * fact charging the regular price for — which is exactly how a projection
   * comes to advertise a charge the nightly run does not make. Set on every
   * Membership Fee charge since #924 stage 3; absent on the Product
   * streams, which have no period of their own.
   */
  periodStatus?: PlanDurationStatus | PromotionTimelineStatus;
  /**
   * #946 — how many Pre-paid periods this charge covers, set only on the one
   * Membership Fee charge that collects a Plan's Pre-paid Duration up front.
   * The line reports it so the simulation can say "3 periods prepaid" rather
   * than leaving a ×3 unexplained; `applyLineBenefit()`-style arithmetic it is
   * not, since the amount is already resolved.
   */
  prepaidPeriods?: number;
}

/**
 * One billable item projected over time. Every item — the Membership Fee and
 * each granted Product alike — is a stream, so the horizon rule (#629
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

/**
 * The date `cycles` complete cadence steps after `start` — the span a caller's
 * `minimumCycles` floor asks the projection to cover (#915). Bounded by the
 * same scan cap as `occurrenceIndexOf`, so a cadence that fails to advance
 * returns the last date it reached rather than spinning.
 */
function cyclesFrom(start: string, cycles: number, cadence: Cadence): string {
  let cursor = start;
  for (let i = 0; i < cycles && i < MAX_OCCURRENCE_SCAN; i++) {
    const next = cadence.advance(cursor);
    if (next <= cursor) break;
    cursor = next;
  }
  return cursor;
}

/**
 * #924 stage 4 — the date of the first occurrence of `start`'s own schedule
 * that falls on or after `from`; `start` itself when it is already there, which
 * is every stream of a hypothetical assignment and every stream beginning after
 * the anchor. Composed from the two helpers above rather than scanning again.
 */
function firstOccurrenceFrom(start: string, from: string, cadence: Cadence): string {
  return cyclesFrom(start, occurrenceIndexOf(start, from, cadence), cadence);
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
    line: (date, resolved) => {
      // #946 — one Membership Fee charge covers more than one period exactly
      // once: when it collects the Plan's Pre-paid Duration up front. The
      // regular price of *that* event is the fee times the periods it pays
      // for, so the line reads "Regular price · €210.00" rather than a €210
      // charge against a €70 regular price.
      const periods = resolved.prepaidPeriods ?? 1;
      return {
        kind: 'membership_fee',
        label: a.planName ?? 'Membership Fee',
        user_membership_id: a.userMembershipId,
        plan_name: a.planName,
        gym_charge_id: null,
        quantity: periods,
        unit_price: regular,
        regular_price: round2(regular * periods),
        benefits: resolved.benefits,
        actual_charge: resolved.amount,
        price_may_change: date >= advanceBillingDate(a.startsAt, 1, 'year'),
        prepaid_periods: resolved.prepaidPeriods ?? null,
      };
    },
  };
}

/* ── Billable Products ─────────────────────────────────────────────── */

/** One Promotion grant, kept with the Promotion that granted it. */
interface GrantCoverage {
  promo: SimulationPromotion;
  grant: SimulationGrant;
}

/**
 * One Product the assignment bills, with every Promotion grant that
 * covers it. Merging on `gymChargeId` is what keeps a Plan's Period Benefit
 * and a Promotion granting the same item one charge — the Promotion covers
 * periods of it rather than adding a second locker.
 */
interface BillableItem {
  gymChargeId: number;
  name: string;
  category: ProductBenefitCategory;
  billingFrequency: ProductFrequency | null;
  unitPrice: number;
  /** Units billed each occurrence (Period Benefit) or once (one-off/session). */
  quantity: number;
  /**
   * #918 — the Session Benefit's renewal Frequency, when the Plan configured
   * one. A renewing frequency turns this item into a stream at the
   * assignment's own billing cadence (`buildSessionAllowanceStream`); `null`
   * and `once` keep the single charge on the start date.
   */
  sessionFrequency: SessionBenefitFrequency | null;
  /**
   * #896 — the item's own treatment: the Plan benefit's `(action, value)` pair
   * when the Plan carries it, and the neutral default for an item that exists
   * only because a Promotion granted it (there is no Plan row to configure one
   * on — the grant's own pair is what prices those units).
   */
  benefit: ProductBenefit;
  coverage: GrantCoverage[];
}

/**
 * The Plan's own benefits plus everything the applied Promotions grant, keyed
 * by Product.
 *
 * An item the Plan does not carry behaves exactly as it did before #635 stage
 * 3: quantity 1 for a periodical grant (the grant covers periods, it does not
 * say how many lockers) and the granted quantity for a one-off/session grant,
 * charged at 0 for as long as the grant covers it.
 */
function collectBillableItems(a: SimulationAssignment): BillableItem[] {
  const byCharge = new Map<string, BillableItem>();
  // A snapshotted grant whose Product has since been deleted carries no
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
      // #918: only a Session Benefit carries one; the other two sections are
      // `null` whatever their row holds.
      sessionFrequency: benefit.category === 'session' ? benefit.sessionFrequency : null,
      benefit: benefit.benefit,
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
        // #918 is a Membership Plan field: a Promotion's session grant has no
        // renewal Frequency of its own, so an item that exists only because a
        // Promotion granted it keeps the single charge it has always been.
        sessionFrequency: null,
        // The item is the Promotion's alone — no Plan row configures it, so the
        // line prices at the catalogue price and the grant's own pair is what
        // changes it for the units/periods it covers.
        benefit: NO_PRODUCT_BENEFIT,
        coverage: [{ promo, grant }],
      });
    }
  }

  return [...byCharge.values()];
}

/**
 * A recurring Product: billed at its own `billing_frequency` from the
 * assignment's start date, priced by the Plan's own treatment of the line, and
 * by a covering Promotion grant's treatment for the periods that grant covers
 * (#629 thread Q3, #635 §14, #896 §11).
 *
 * Until #896 stage 3 a covered period was free and an uncovered one cost the
 * full line. Both are now the `no_benefit`/`waive` cases of one rule:
 *
 *   line   = unit x quantity                      (`regular_price`, unchanged)
 *   base   = the Plan's own pair applied to it    (`no_benefit` for every row
 *                                                  written before migration 203)
 *   charge = each covering grant's pair applied to `base`, in turn
 *
 * The grants fold rather than replace, because two Promotions may cover the
 * same period and the member is entitled to both; folding a `waive` over
 * anything still gives 0, which is why every existing configuration keeps its
 * price to the cent.
 */
function buildItemStream(a: SimulationAssignment, item: BillableItem): Stream | null {
  const cadence = item.billingFrequency ? cadenceForProduct(item.billingFrequency) : null;
  if (!cadence) return null;
  const unit = round2(item.unitPrice);
  const regular = round2(unit * item.quantity);
  // The Plan's own treatment of the line. It applies to every occurrence for
  // the life of the assignment, so — exactly like the Personal Membership Fee
  // Benefit (#772) — it never sets `promotional`: a discount that never ends
  // *is* this contract's regular charge, and treating it as promotional would
  // push the horizon to the safety cap for every discounted item.
  const base = applyLineBenefit(unit, item.quantity, item.benefit);
  const planBenefitLines: SimulationBenefit[] = item.benefit.action === 'no_benefit' ? [] : [{
    source: 'membership_plan', name: null,
    action: item.benefit.action, value: item.benefit.value, period_status: null,
  }];
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
      let amount = base;
      const benefits = [...planBenefitLines];
      let promotional = false;
      for (const c of covering) {
        const { action, value } = c.grant.benefit;
        // A grant covering the period with no treatment configured charges the
        // normal price and explains nothing — and, deliberately, does not make
        // the occurrence promotional: the projection's horizon asks whether a
        // charge differs from the regular one, and this one does not.
        if (action === 'no_benefit') continue;
        amount = applyPeriodBenefit(amount, action, value);
        benefits.push({ source: 'promotion', name: c.promo.name, action, value, period_status: null });
        promotional = true;
      }
      if (promotional) return { amount, benefits, promotional, pending: false };
      const pending = coverage.some((c) => occurrence < c.firstCovered
        && (c.promo.revokedAt == null || date <= c.promo.revokedAt));
      return { amount, benefits, promotional: false, pending };
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
      prepaid_periods: null,
    }),
  };
}

/**
 * #631 — an Additional Periodic Service.
 *
 * Billed at the Product's own cadence and price, from the later of the
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
  const cadence = service.billingFrequency ? cadenceForProduct(service.billingFrequency) : null;
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
      prepaid_periods: null,
    }),
  };
}

/**
 * A one-off or session item: no schedule to project, so it is a single line on
 * the assignment's start date covering the whole quantity (#629 thread Q5 —
 * `per_session` items appear as "N sessions").
 *
 * Each Promotion grant prices as many units as it grants, capped at the
 * quantity actually billed, and whatever is left over is priced by the Plan's
 * own treatment: a Plan carrying 10 sessions and a Promotion waiving 4 of them
 * charges the remaining 6, while an item the Plan does not carry at all is
 * granted in full. Since #896 stage 3 "prices" is the grant's own
 * `(action, value)` pair rather than an implicit free — 4 waived units cost 0
 * exactly as before (migration 203 backfilled every existing grant to `waive`),
 * and 4 units at 20% off cost 80% of their share of the line.
 *
 * The units are allocated grant by grant, in the order the grants were
 * collected: each one may only treat units no earlier grant has taken, so two
 * Promotions granting 4 sessions each on a 6-session Plan discount 4 and 2, not
 * 8 of 6.
 */
/**
 * `quantity` units of a one-off/session line, priced — with `offset` saying how
 * many units of the same line earlier occurrences have already consumed.
 *
 * The allocation is interval arithmetic over the line's units: the first grant
 * owns units `[0, q1)`, the second `[q1, q1+q2)`, and everything past the last
 * grant is priced by the item's own treatment. For a single charge (`offset =
 * 0`, `quantity` = the whole line) that is exactly the rule #896 stage 3
 * described, to the cent.
 *
 * `offset` is what makes a **renewing** allowance (#918) keep the same meaning:
 * a Promotion granting 4 sessions grants 4 sessions in total, not 4 every
 * cycle, so once the first cycles have used them up the later ones price at the
 * Plan's own treatment.
 */
function allocateSessionUnits(
  item: BillableItem, unit: number, offset: number, quantity: number,
): { amount: number; benefits: SimulationBenefit[]; promotional: boolean } {
  const benefits: SimulationBenefit[] = [];
  let amount = 0;
  let covered = 0;
  let promotional = false;
  let cursor = 0;
  for (const c of item.coverage) {
    const granted = Math.max(0, Math.trunc(c.grant.quantity) || 0);
    const start = cursor;
    cursor += granted;
    if (granted <= 0) continue;
    const units = Math.min(offset + quantity, cursor) - Math.max(offset, start);
    if (units <= 0) continue;
    covered += units;
    amount += applyLineBenefit(unit, units, c.grant.benefit);
    const { action, value } = c.grant.benefit;
    // A grant that covers units without changing their price explains nothing,
    // and — as in `buildItemStream` — does not make the charge promotional:
    // the horizon asks whether a charge differs from the regular one.
    if (action !== 'no_benefit') {
      benefits.push({ source: 'promotion', name: c.promo.name, action, value, period_status: null });
      promotional = true;
    }
  }
  const remaining = quantity - covered;
  if (remaining > 0) {
    amount += applyLineBenefit(unit, remaining, item.benefit);
    if (item.benefit.action !== 'no_benefit') {
      benefits.push({
        source: 'membership_plan', name: null,
        action: item.benefit.action, value: item.benefit.value, period_status: null,
      });
    }
  }
  return { amount: round2(amount), benefits, promotional };
}

function buildItemSingleCharge(a: SimulationAssignment, item: BillableItem): SingleCharge {
  const unit = round2(item.unitPrice);
  const { amount, benefits } = allocateSessionUnits(item, unit, 0, item.quantity);
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
      regular_price: round2(unit * item.quantity),
      benefits,
      actual_charge: amount,
      price_may_change: false,
      prepaid_periods: null,
    },
  };
}

/**
 * #918 — a Session Benefit whose Frequency renews it: `2 | Weekly` is not one
 * charge of 2 sessions on the start date, it is 2 sessions every week for the
 * life of the assignment.
 *
 * The projection does **not** list one line per week. The #918 thread's Q1
 * answer is explicit that the allowance is summarised on the billing event it
 * falls in — "if 4 weeks → 4x2 sessions | 50% Discount | 200€ (8 x 50€ x 50%)",
 * "if 1 month → num_weeks_month x 2" — so the stream runs at the **assignment's
 * own billing cadence** (`ASSIGNMENT_CADENCE`, the cadence the Membership Fee
 * is billed at) and each occurrence reports `quantity x` the renewals that fall
 * inside that cycle (`renewalsInPeriod()`). The renewals are one schedule from
 * the assignment's start date, so a weekly allowance reports the 5 renewals of
 * a 31-day cycle beginning on the 1st and the 4 of the next, rather than a
 * fractional 4.35.
 *
 * It keeps the `session` section rather than the cadence's, because what it
 * projects is still the Session Benefit the Plan configured — only its dates
 * come from the fee's cadence.
 *
 * An assignment with no cadence at all (no `billing_policies` pair and nothing
 * frozen) has no billing events to summarise onto, so the allowance falls back
 * to the single charge it was before this ticket rather than inventing a
 * schedule of its own.
 *
 * Nothing here is a new charge the gym was not already making: a Session
 * Benefit is a line of the contract, and this is the simulation reporting what
 * the configured Frequency says it grants. The ticket's "this is not a billing
 * event" is about the *allowance renewal* not being an extra event of its own —
 * which is exactly why the renewals are summarised onto the billing dates that
 * already exist instead of generating weekly ones.
 */
function buildSessionAllowanceStream(a: SimulationAssignment, item: BillableItem): Stream | null {
  const frequency = item.sessionFrequency;
  if (item.category !== 'session' || !isRenewingSessionFrequency(frequency)) return null;
  if (a.recurringInterval == null || a.recurringUnit == null) return null;
  const cadence = cadenceForBillingPolicy(a.recurringInterval, a.recurringUnit);
  const unit = round2(item.unitPrice);
  const unitsIn = (from: string, to: string) =>
    item.quantity * renewalsInPeriod(a.startsAt, from, to, frequency);

  return {
    cadence,
    section: 'session',
    start: a.startsAt,
    end: a.endsAt,
    resolve: (date) => {
      const quantity = unitsIn(date, cadence.advance(date));
      if (quantity <= 0) return { amount: 0, benefits: [], promotional: false, pending: false, quantity };
      // The units this cycle grants come after everything the earlier cycles
      // granted, so a Promotion's session grant is spent once rather than
      // renewed with the allowance.
      const allocated = allocateSessionUnits(item, unit, unitsIn(a.startsAt, date), quantity);
      return { ...allocated, pending: false, quantity };
    },
    line: (date, resolved) => {
      const quantity = resolved.quantity ?? item.quantity;
      return {
        kind: 'sellable_item',
        label: item.name,
        user_membership_id: a.userMembershipId,
        plan_name: a.planName,
        gym_charge_id: item.gymChargeId > 0 ? item.gymChargeId : null,
        quantity,
        unit_price: unit,
        regular_price: round2(unit * quantity),
        benefits: resolved.benefits,
        actual_charge: resolved.amount,
        price_may_change: date >= advanceBillingDate(a.startsAt, 1, 'year'),
        prepaid_periods: null,
      };
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
    // #918: a renewing session allowance whose cycle contains no renewal has
    // nothing to show — a line reading "0 sessions, €0.00" is not a billing
    // event. Every other stream leaves `quantity` unset and always emits.
    if (resolved.quantity == null || resolved.quantity > 0) {
      events.push({
        section: stream.section,
        date: cursor,
        period_end: stream.cadence.ranged ? dayBefore(next) : null,
        line: stream.line(cursor, resolved),
      });
    }
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
        // #918: a Session Benefit with a renewing Frequency is projected over
        // the assignment's billing dates; everything else is one charge on the
        // start date, exactly as before.
        const renewing = buildSessionAllowanceStream(a, item);
        if (renewing) streams.push(renewing);
        else singles.push(buildItemSingleCharge(a, item));
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
  // #924 stage 4 — where the horizon is measured from. For a hypothetical
  // assignment (a Plan or Promotion preview) that is the earliest stream start,
  // which is today; for a contract that already exists it is the caller's own
  // anchor, because a cap counted from a `starts_at` three years ago lands in
  // the past and would project nothing at all for the cycles still ahead.
  const horizonFrom = maxDate(startDate, input.horizonFrom ?? startDate);
  const cap = advanceBillingDate(horizonFrom, input.maxMonths ?? MAX_SIMULATION_MONTHS, 'month');

  // Pass 1 — each stream's own first regular (unbenefited) charge, and (#915)
  // the caller's floor of N complete cycles of that stream, whichever is later.
  const minimumCycles = Math.max(0, Math.trunc(input.minimumCycles ?? 0) || 0);
  let horizon = startDate;
  let truncated = false;
  for (const stream of streams) {
    const { events, capped } = walkStream(stream, cap, (_d, r) => !r.promotional && !r.pending);
    if (capped) truncated = true;
    const last = events[events.length - 1];
    if (last) horizon = maxDate(horizon, last.date);
    // Counted from this stream's first occurrence at or after the anchor, not
    // from its own start, for the same reason: N cycles of a stream that began
    // years ago are already behind us. For a stream that starts at the anchor —
    // every stream of a hypothetical assignment — the two are the same date, so
    // the Plan and Promotion previews are unaffected.
    const floor = cyclesFrom(
      firstOccurrenceFrom(stream.start, horizonFrom, stream.cadence), minimumCycles, stream.cadence,
    );
    const bounded = stream.end != null ? minDate(floor, stream.end) : floor;
    horizon = maxDate(horizon, minDate(bounded, cap));
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
