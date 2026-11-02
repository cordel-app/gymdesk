// #1613 — the Products tab's unified workflow, decided without React.
//
// The ProductSet's status, whether a change affects billing and what the
// review's diff contains are the server's (`/product-sets`, `…/review`); this
// module only combines them into the three answers the tab shows: the PS Status
// chip, the billing section's mode and whether the one global Save & Pay is on.
// It prices nothing and never reads the form's dirty state.

import type { ProductSetSummary } from './membershipConfiguration';

/** The `members.ps_status_*` suffix of a ProductSet status, `null` for one the build does not know. */
const PS_STATUSES = ['draft', 'pending_payment', 'active', 'superseded'] as const;
export function psStatusKey(current: ProductSetSummary | null, holdsNothing = false): string | null {
  const s = current?.status;
  // #2264 — a cancelled plan leaves an Active version with no plan and no
  // Products: nothing is assigned, so the status is None, not Active.
  if (s === 'active' && !current?.plan_name && holdsNothing) return null;
  return s && (PS_STATUSES as readonly string[]).includes(s) ? s : null;
}

/** A one-off purchase waiting for its payment: it will generate an immediate Billing Event. */
export function pendingOneOffCount(purchases: Array<{ status: string }>): number {
  return purchases.filter((p) => p.status === 'pending_payment').length;
}

/** The review answer reduced to what the mode needs. */
export interface ReviewSummary {
  changes: unknown[];
  amount_due: number | null;
}

export interface WorkflowInput {
  current: ProductSetSummary | null;
  /** `GET /product-sets/:id/review` of the Draft; `null` until read or when there is no Draft. */
  review: ReviewSummary | null;
  pendingOneOffs: number;
}

export type BillingMode = 'simulation' | 'events';

/**
 * Simulation while the proposed configuration differs from the committed one
 * (a Draft whose review lists changes), while a version awaits payment, or
 * while a one-off purchase will generate an immediate Billing Event. An empty
 * Draft — opened and never changed — affects nothing and stays on the ledger.
 */
export function billingMode(input: WorkflowInput): BillingMode {
  if (input.pendingOneOffs > 0) return 'simulation';
  const status = input.current?.status;
  if (status === 'pending_payment') return 'simulation';
  if (status === 'draft' && !input.current?.expired && (input.review?.changes.length ?? 0) > 0) return 'simulation';
  return 'events';
}

/** The global Save & Pay: on while something supported waits to be saved or paid. */
export function saveAndPayEnabled(input: WorkflowInput & { canWrite: boolean }): boolean {
  if (!input.canWrite) return false;
  return billingMode(input) === 'simulation';
}

/**
 * Which surface Save & Pay opens. A Draft or a pending version goes through the
 * existing review → save-and-pay flow; a pending one-off alone keeps its own
 * payment link, so the action points the operator to the Products card.
 */
export function saveAndPayTarget(input: WorkflowInput): 'review' | 'purchases' | null {
  const status = input.current?.status;
  if (status === 'pending_payment') return 'review';
  if (status === 'draft' && !input.current?.expired && (input.review?.changes.length ?? 0) > 0) return 'review';
  return input.pendingOneOffs > 0 ? 'purchases' : null;
}

/** Display-only: hide the rows of a simulation whose charge is zero (and the dates left empty). */
export function withoutZeroRows<
  T extends { dates: Array<{ lines: Array<{ actual_charge: number }>; total: number }>; total: number },
>(simulation: T | null, hideZero: boolean): T | null {
  if (!simulation || !hideZero) return simulation;
  const dates = simulation.dates
    .map((d) => ({ ...d, lines: d.lines.filter((l) => Number(l.actual_charge) !== 0) }))
    .filter((d) => d.lines.length > 0);
  return { ...simulation, dates };
}
