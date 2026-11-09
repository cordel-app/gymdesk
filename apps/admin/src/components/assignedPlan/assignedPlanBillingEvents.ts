/**
 * #2553 — the two decisions both Admin entry points to an Assigned Plan share
 * (Members → Products → Membership Plan, and Assigned Plans): when the billing
 * simulations are shown, and where *View Billing Events* goes. UI-only: it
 * prices and charges nothing.
 */

/** Statuses in which the plan is still being drafted or awaiting its first payment. */
const SIMULATION_STATUSES = ['draft', 'pending_payment'];

/** Membership Fee Simulation and Billing Event Forecast: Draft / Pending Payment only. */
export function showsBillingSimulations(status: string | null | undefined): boolean {
  return status != null && SIMULATION_STATUSES.includes(status);
}

/**
 * The Billing Events page filtered to one Assigned Plan (all the ProductSet
 * versions of its chain, filtered server-side) with the Member's context kept.
 * It is the Billing Events view, never the Payments tab.
 */
export function viewBillingEventsPath(
  locale: string,
  plan: { id: number; plan_name?: string | null; member_id?: number | null; member_name?: string | null },
): string {
  const p = new URLSearchParams();
  if (plan.member_id) {
    p.set('memberId', String(plan.member_id));
    p.set('memberName', plan.member_name ?? '');
  }
  p.set('userMembershipId', String(plan.id));
  p.set('planName', plan.plan_name ?? '');
  return `/${locale}/payments/billing-events?${p.toString()}`;
}
