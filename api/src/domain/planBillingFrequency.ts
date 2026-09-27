// #820: a Membership Plan's **Billing frequency** is one of two cadences.
//
// `billing_policies` has carried a free `(interval, unit)` pair since migration
// 060, and the Billing & Duration section offered a number box plus the whole
// `recurring_billing_unit` ENUM — "every 3 days", "every 2 years" and every
// other combination nobody sells. #820 reduces the *product* surface to the two
// a gym actually bills on:
//
//     Month     → 1 month
//     4 Weeks   → 4 week
//
// It is deliberately **not** a new column, a new enum or a second cadence
// concept (CLAUDE.md: "no second cadence, service-period concept or per-plan
// billing column may be reintroduced"). The wire format and the stored pair are
// unchanged, so `ASSIGNMENT_CADENCE`, every assignment's frozen snapshot
// (migration 174) and `advanceBillingDate()` keep reading exactly what they read
// before — this module only says which pairs a Plan may be *configured* with,
// and `PUT /membership-plans/:id/billing-policy` is where that is enforced.
//
// Rows that predate the rule are left alone on purpose: a Plan stored as "every
// 2 months" still reads back, bills and displays as every 2 months (§"Existing
// Membership Plans must continue to display their current billing frequency"),
// and `planBillingFrequencyOf()` answers `null` for it so a caller can say so
// rather than silently reporting one of the two.

import { BillingDateUnit } from './billingDate';

/** The Plan-level choices, in the order the dropdown offers them. */
export const PLAN_BILLING_FREQUENCIES = ['month', 'four_weeks'] as const;

export type PlanBillingFrequency = (typeof PLAN_BILLING_FREQUENCIES)[number];

export interface PlanBillingCadence {
  interval: number;
  unit: BillingDateUnit;
}

/** What each choice stores in `billing_policies`. */
export const PLAN_BILLING_FREQUENCY_CADENCE: Record<PlanBillingFrequency, PlanBillingCadence> = {
  month: { interval: 1, unit: 'month' },
  four_weeks: { interval: 4, unit: 'week' },
};

/** The cadence a new Plan is created with (`DEFAULT_BILLING_POLICY`). */
export const DEFAULT_PLAN_BILLING_FREQUENCY: PlanBillingFrequency = 'month';

export function isPlanBillingFrequency(value: unknown): value is PlanBillingFrequency {
  return typeof value === 'string' && (PLAN_BILLING_FREQUENCIES as readonly string[]).includes(value);
}

/**
 * Which choice a stored `(interval, unit)` pair is, or `null` for a cadence
 * outside the two — a row written before #820, or one inserted straight into
 * the database. `null` is information, not an error: it is what lets a screen
 * keep showing "Every 2 months" instead of mislabelling it.
 *
 * The interval is compared numerically (a `DECIMAL`/string column reads back as
 * a string through some drivers) and the unit exactly.
 */
export function planBillingFrequencyOf(interval: unknown, unit: unknown): PlanBillingFrequency | null {
  const n = Number(interval);
  if (!Number.isInteger(n)) return null;
  for (const freq of PLAN_BILLING_FREQUENCIES) {
    const cadence = PLAN_BILLING_FREQUENCY_CADENCE[freq];
    if (cadence.interval === n && cadence.unit === unit) return freq;
  }
  return null;
}

/** Whether a Plan may be *configured* with this pair (what the route enforces). */
export function isAcceptedPlanCadence(interval: unknown, unit: unknown): boolean {
  return planBillingFrequencyOf(interval, unit) !== null;
}

/** `1 month, 4 week` — for the route's 400 message and for docs. */
export function describeAcceptedPlanCadences(): string {
  return PLAN_BILLING_FREQUENCIES
    .map((f) => {
      const { interval, unit } = PLAN_BILLING_FREQUENCY_CADENCE[f];
      return `${interval} ${unit}`;
    })
    .join(', ');
}
