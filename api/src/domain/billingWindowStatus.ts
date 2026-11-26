// #3444 — whether a Product Set's rolling window reached its target after a maintenance pass.
// Pure: `maintainBillingWindow()` hands it what the pass planned and what is persisted.
//
// The target is the set's, not each schedule's: `target` distinct future positive billing dates
// holding a Scheduled Billing Event, across every schedule (#3445 stage 2).
//   - `at_target`: already held them before the pass (nothing created);
//   - `replenished`: holds them now, after the pass created some;
//   - `shortfall`: holds fewer, and the contract itself owes fewer future obligations within the
//     window's horizon (an ended or ending contract, a long free stretch) — legitimate;
//   - `incomplete`: holds fewer than the window planned — the pass did not leave what it should
//     have, which makes the run operationally incomplete.

export type WindowTargetStatus = 'at_target' | 'replenished' | 'shortfall' | 'incomplete';

export function windowTargetStatus(input: {
  target: number;
  /** Planned dates that hold a Billing Event after the pass (persisted, or paid up front). */
  persistedDates: number;
  /** Distinct future positive scheduled dates the window planned. */
  plannedDates: number;
  /** Billing Events the pass created. */
  created: number;
}): WindowTargetStatus {
  const { target, persistedDates, plannedDates, created } = input;
  // Every planned date up to the target must hold an event; only then does a short plan mean the
  // contract owes fewer obligations rather than the pass leaving them out.
  if (persistedDates < Math.min(plannedDates, target)) return 'incomplete';
  if (persistedDates >= target) return created > 0 ? 'replenished' : 'at_target';
  return 'shortfall';
}
