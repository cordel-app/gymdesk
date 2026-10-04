// #918 — a Membership Plan **Session Benefit** carries a Frequency of its own:
// the period on which the included sessions are renewed.
//
//   SESSION BENEFITS
//   PRODUCT                   QUANTITY   FREQUENCY   BENEFIT
//   Personal Training Class      2       Weekly      Waive
//
// reads "2 Personal Training Classes every week, included in the membership".
//
// **Why this is its own option set, and not the Product's.** A Product
// Item's `billing_frequency` (`domain/productFrequency.ts`) answers "how
// often is this item *priced*", and #821 deliberately retired `week` from that
// surface: nobody sells a weekly locker rental. The question here is a
// different one — how often an *allowance* renews — and the ticket thread's Q2
// answer is explicit that weekly is exactly the case it exists for ("It is the
// way to cover 1 session per week or 2 sessions per week. Products cannot
// be purchased per weeks"). So `week` is offered here without being un-retired
// over there, and `per_session` is not offered at all: it is not a period, and
// it is being removed from the Product surface in #945.
//
// `once` is offered and means what the thread says it means — "Once will take
// place once. At the beginning of the assignment" — which is also what a
// Session Benefit stored before this ticket does. `null` (the dropdown's `—`)
// is the backwards-compatible default every existing row keeps and behaves
// identically; the two are kept distinct because an explicit `Once` is a
// statement the gym made and `—` is the absence of one.
//
// A new value goes in **two** places: `SESSION_BENEFIT_FREQUENCIES` below and
// the `chk_<table>_frequency` CHECK beside it (current definition: migration
// 205), which `session-benefit-frequency.unit.test.ts` asserts agree. The
// browser's mirror is `apps/admin/src/lib/sessionBenefitFrequency.ts`.

import { advanceBillingDate, BillingDateUnit } from './billingDate';

/** What a Session Benefit's Frequency may be configured with, in dropdown order. */
export const SESSION_BENEFIT_FREQUENCIES = ['once', 'week', 'four_weeks', 'month', 'year'] as const;

export type SessionBenefitFrequency = (typeof SESSION_BENEFIT_FREQUENCIES)[number];

/** The ones that renew: everything but `once`, which happens at the start and never again. */
export const RENEWING_SESSION_BENEFIT_FREQUENCIES: readonly SessionBenefitFrequency[] =
  SESSION_BENEFIT_FREQUENCIES.filter((f) => f !== 'once');

export function isSessionBenefitFrequency(value: unknown): value is SessionBenefitFrequency {
  return typeof value === 'string'
    && (SESSION_BENEFIT_FREQUENCIES as readonly string[]).includes(value);
}

/**
 * Whether this frequency renews the allowance — i.e. whether the Billing Event
 * Simulation projects the line over time instead of once at the start. `null`
 * and `once` are the same answer here, which is what keeps every Session
 * Benefit stored before #918 projecting exactly as it did.
 */
export function isRenewingSessionFrequency(value: unknown): value is SessionBenefitFrequency {
  return isSessionBenefitFrequency(value) && value !== 'once';
}

/** A stored column value, normalized: a known frequency or `null`. */
export function toSessionBenefitFrequency(value: unknown): SessionBenefitFrequency | null {
  return isSessionBenefitFrequency(value) ? value : null;
}

/** `once, week, four_weeks, month, year` — for a route's 400 message. */
export function describeSessionBenefitFrequencies(): string {
  return SESSION_BENEFIT_FREQUENCIES.join(', ');
}

/**
 * What a replace-all `PUT` should do with one line's Frequency.
 *
 * The three answers are #896's, for #896's reason: the six benefit section
 * `PUT`s are replace-all, so a client that sends `product_id` + `quantity`
 * alone — the Assigned Plan snapshot editor, a mandatory item re-added by
 * `withMandatoryBenefits()`, any caller written before this ticket — must keep
 * the Frequency the line is stored with rather than silently clearing it.
 *
 *   `keep`  — the request named no Frequency at all.
 *   `set`   — an explicit value, or `null` for the dropdown's `—`.
 *   `error` — anything else, which is a 400 and never a coercion.
 */
export type SessionFrequencyInput =
  | { keep: true; frequency?: undefined; error?: undefined }
  | { keep: false; frequency: SessionBenefitFrequency | null; error?: undefined }
  | { keep?: undefined; frequency?: undefined; error: string };

export function parseSessionBenefitFrequencyInput(item: unknown): SessionFrequencyInput {
  const raw = (item as { frequency?: unknown } | null | undefined)?.frequency;
  if (raw === undefined) return { keep: true };
  // `—` arrives as an empty string from the select and as `null` from a client
  // that normalizes it; both mean "no frequency", explicitly chosen.
  if (raw === null || raw === '') return { keep: false, frequency: null };
  if (isSessionBenefitFrequency(raw)) return { keep: false, frequency: raw };
  return { error: `frequency must be one of: ${describeSessionBenefitFrequencies()}` };
}

/** One renewal step of each frequency, in `advanceBillingDate()`'s vocabulary. */
const RENEWAL_STEP: Record<SessionBenefitFrequency, { interval: number; unit: BillingDateUnit }> = {
  // `once` never steps; it is here so the record is exhaustive and a new
  // frequency cannot be added without deciding its step.
  once: { interval: 0, unit: 'day' },
  week: { interval: 7, unit: 'day' },
  // 4-week billing is 28 days — never approximated as a month (#634 §10).
  four_weeks: { interval: 28, unit: 'day' },
  month: { interval: 1, unit: 'month' },
  year: { interval: 1, unit: 'year' },
};

/** Bounded so a degenerate anchor/period can never spin the projection. */
const MAX_RENEWAL_SCAN = 2000;

/**
 * How many renewals of `frequency` fall inside `[periodStart, periodEnd)`, on
 * the schedule anchored at `anchor`.
 *
 * This is what the ticket thread's Q1 answer asks for: the Billing Event
 * Simulation does not list one line per week, it **summarises the allowance on
 * the billing event it falls in** — "if 4 weeks → 4x2 sessions | 50% Discount |
 * 200€ (8 x 50€ x 50%)", "if 1 month → num_weeks_month x 2".
 *
 * The renewals are one schedule from the assignment's own start date rather
 * than from each cycle's start, so a weekly allowance on monthly billing
 * reports the 5 renewals that genuinely fall in a 31-day cycle beginning on the
 * 1st and the 4 that fall in the next — the same arithmetic a gym would do by
 * hand, and never a fractional "4.35 weeks".
 *
 * A period that contains no renewal answers 0, and the caller decides what that
 * means (the projection omits the line rather than showing an allowance of 0).
 */
export function renewalsInPeriod(
  anchor: string,
  periodStart: string,
  periodEnd: string,
  frequency: SessionBenefitFrequency | null,
): number {
  if (!isRenewingSessionFrequency(frequency)) return 0;
  if (periodEnd <= periodStart) return 0;
  const { interval, unit } = RENEWAL_STEP[frequency];
  let cursor = anchor;
  let count = 0;
  for (let steps = 0; steps < MAX_RENEWAL_SCAN && cursor < periodEnd; steps++) {
    if (cursor >= periodStart) count++;
    const next = advanceBillingDate(cursor, interval, unit);
    if (next <= cursor) break;
    cursor = next;
  }
  return count;
}
