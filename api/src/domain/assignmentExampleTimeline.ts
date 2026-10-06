// #924 stage 3 — the **Membership Fee Simulation** of one Assigned Plan: the
// Membership Plan card's Example Timeline (#818), for a contract that really
// exists.
//
// §7 of the ticket asks for "the same simulation logic and presentation as
// Membership Plans", with the same dates, frequencies, pricing, benefits,
// promotions, tax and recurrence rules as the actual billing logic, and
// explicitly: *"The simulation should not implement a separate calculation
// engine."* So this module is an **adapter**, nothing more — the shared walk
// (`exampleTimeline.ts`) steps the periods and `resolveMembershipFee()` prices
// each one, which is the single implementation of "what does the Membership
// Fee cost on this date" that the nightly run, My Membership and every staff
// surface already read (#635 stage 12). The table therefore cannot advertise a
// charge the run does not make, in either direction.
//
// What the assignment brings that a Plan preview cannot have:
//
//   - **Real dates.** The periods are counted from the assignment's own
//     `starts_at` (never snapped to the first of a month — #635 §7), in
//     periods of the assignment's own cadence (`ASSIGNMENT_CADENCE`, #892).
//   - **Its applied Promotions**, each inside its own agreed window, which
//     outrank the Plan's durations where they govern a date (#635's Q2
//     answer). The status column therefore reports whichever of the two
//     actually decided the cycle — `resolveMembershipFee()` says which
//     (`periodStatus`), and nothing here re-derives it.
//   - **Its Personal Membership Fee Benefit** (#772), which is bounded by
//     nothing and discounts every row.
//
// The rows start at the period containing today rather than at `starts_at`: a
// member assigned three years ago has three years of elapsed cycles, and the
// question the section answers is what will be charged from here on. The
// period *numbers* still count from `starts_at`, because that is what the
// Billing & Duration counts.
//
// Nothing is persisted and nothing is charged.

import { MembershipFeeContext, resolveMembershipFee } from './billingSimulation';
import { PlanDurationCadence, withDurationCadence } from './planDuration';
import {
  ExampleTimelineResult,
  periodContaining,
  timelineCycleFor,
  walkExampleTimeline,
} from './exampleTimeline';

const NO_CADENCE_REASON =
  'This assigned plan has no billing frequency, so there is nothing to simulate.';

export interface AssignmentExampleTimelineInput {
  /**
   * Everything the fee depends on, built by `membershipFeeContextFor()` — the
   * very object the nightly run and `priceMembershipFeeOn()` price a cycle
   * with. Taking it whole rather than rebuilding it from the row is what makes
   * a drift between the table and the charge impossible: the contract's
   * anchor, its Billing & Duration, its standing Promotions and its Personal
   * Membership Fee Benefit are all already in it.
   */
  context: MembershipFeeContext;
  /**
   * `ASSIGNMENT_CADENCE`: the assignment's own frozen pair, then its Plan's
   * live one. `null` when it has neither — there is no timeline at all, which
   * is the same answer a Plan with no `billing_policies` row gets. (The
   * context's own `planDuration.cadence` cannot stand in for it: that one
   * falls back to `1 month` for a row with no cadence at all, which is right
   * for classifying a period and wrong for claiming a billing date.)
   */
  cadence: PlanDurationCadence | null;
  /**
   * The regular fee this contract is priced *from* on a given date — the
   * number every benefit discounts. A callback rather than a number because a
   * negotiated fee can lapse (`discount_expires_at`), after which the
   * assignment falls back to its Plan's price window exactly as
   * `priceMembershipFeeOn()` makes it (there are only ever two values, so the
   * caller resolves both once and picks between them per date).
   */
  regularFeeOn: (date: string) => number | null;
  /** "Today", `YYYY-MM-DD`. Defaults to the UTC date — tests pin it. */
  today?: string;
}

/**
 * One row per billing period of this assignment, from the period containing
 * today, each priced by `resolveMembershipFee()` at its own start date.
 */
export function computeAssignmentExampleTimeline(
  input: AssignmentExampleTimelineInput,
): ExampleTimelineResult {
  const { cadence } = input;
  const startsAt = input.context.startsAt.slice(0, 10);
  const today = (input.today ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  // #892 — the counts are periods of the cadence the rows step by, so the two
  // halves of a row can never be stepped differently.
  const context: MembershipFeeContext = cadence
    ? { ...input.context, planDuration: withDurationCadence(input.context.planDuration, cadence) }
    : input.context;

  // #1130 stage 3 — the shared rule, because the Billing Event Forecast beside
  // this table counts its displayed iterations from the very same period.
  const { startOn, firstPeriod } = periodContaining(startsAt, today, cadence);

  return walkExampleTimeline({
    cadence,
    anchorDate: startsAt,
    startOn,
    firstPeriod,
    // #1130 — the same bound the Plan preview takes, from the same helper and
    // off this assignment's **own** frozen `auto_renew`: a renewing contract
    // has no regular period for the trailing rule to find.
    cycle: timelineCycleFor(context.planDuration),
    reasonWhenNoCadence: NO_CADENCE_REASON,
    priceOn: (periodStartsOn) => {
      const regular = input.regularFeeOn(periodStartsOn);
      // No fee to quote at all (no frozen price, no Plan price window): the row
      // reads as the admin's empty value rather than as €0.00, which would
      // claim the member is charged nothing.
      if (regular == null) {
        return {
          status: 'pay_regular', amount: null, waived: false, prepaidPeriods: null, regular: true,
        };
      }
      const resolved = resolveMembershipFee(regular, periodStartsOn, context);
      const amount = Math.round(Math.max(0, resolved.amount) * 100) / 100;
      return {
        // Reported by the resolver, never re-classified here: the precedence
        // between an applied Promotion and the Plan's own durations is its
        // decision alone.
        status: resolved.periodStatus ?? 'pay_regular',
        amount,
        // The same rule `priceMembershipFeeOn()` applies: a cycle that owes
        // nothing is waived, whether a period waived it or the benefits priced
        // it at zero. A Pre-paid lump is never waived — it charges.
        waived: amount === 0,
        prepaidPeriods: resolved.prepaidPeriods ?? null,
        // The horizon: a cycle still inside a configured window (a Promotion's
        // timeline, the assignment's own durations) is not the contract's
        // regular charge, and neither is one whose Promotion has yet to start.
        regular: !resolved.promotional && !resolved.pending,
      };
    },
  });
}
