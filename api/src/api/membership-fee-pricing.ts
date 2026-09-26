import { db, Tx } from '../infra/db';
import { MembershipFeeContext, SimulationPromotion, resolveMembershipFee } from '../domain/billingSimulation';
import { PlanDuration, PlanDurationStatus, toPlanDuration } from '../domain/planDuration';
import { PromotionTimelineStatus } from '../domain/promotionTimeline';
import { loadPromotionApplicationsFor, regularMembershipFee } from './user-memberships';

/**
 * #635 stage 15 — an assignment's Membership Fee is **computed**, never stored.
 *
 * `user_memberships.final_price` used to hold "the agreed price after
 * Promotions", recomputed at every apply/revoke. It was a single number with no
 * date in it, so it could not express what stages 8/11/12 established: a cycle
 * inside a Free Period, a Bonus Duration or a Pre-paid Duration costs nothing,
 * and an applied Promotion's Membership Fee Benefit ends with the Promotion's own
 * Free/Paid/Bonus timeline. Every path that needed a *correct* price therefore
 * already resolved it through `resolveMembershipFee()`, and the stored column was
 * only kept alive behind `billing.date_aware_membership_fee` so the difference
 * could be reported before it moved money. The #635 thread's answer to that
 * report — *"remove the billing.date_aware_membership_fee feature flag entirely,
 * as well as the stored final_price approach. Date-aware Membership Fee pricing
 * should be standard system behaviour, with pricing calculated dynamically"* — is
 * this module: the column is gone (migration 191), the flag is gone, and this is
 * the one place that answers "what does this assignment's Membership Fee cost on
 * this date".
 *
 * What an assignment *does* own is its **regular** fee — `membership_fee_price`,
 * frozen at assignment time and editable only on the assignment itself
 * (`PUT /user-memberships/:id/billing-duration`, §15). A negotiated price is that
 * column plus a `discount_reason`; Promotions are then applied to it per date,
 * from each application's own snapshot. So nothing about §13 changes: a Plan, a
 * Promotion or a Sellable Item repriced later still cannot move an existing
 * assignment, because the only live read left is the price-window fallback for an
 * assignment that captured no snapshot at all.
 */

/**
 * 1 when any of the seven snapshot columns is set. Decides the all-or-nothing
 * fallback: an assignment that captured *anything* reads its own columns, NULLs
 * included, so a Free Period added to its Plan later cannot reach it (§13).
 */
export const HAS_BILLING_SNAPSHOT_SQL = `
  (um.free_months IS NOT NULL OR um.paid_months IS NOT NULL OR um.pay_beforehand_months IS NOT NULL
   OR um.bonus_months IS NOT NULL OR um.recurring_billing_interval IS NOT NULL
   OR um.recurring_billing_unit IS NOT NULL OR um.membership_fee_price IS NOT NULL
  )`;

/**
 * Every column the resolver reads, for a query that joins `user_memberships um`
 * to `membership_plans p`. Spelled once so a caller cannot accidentally price an
 * assignment off a subset of its own snapshot.
 */
export const MEMBERSHIP_FEE_COLUMNS = `
  um.id, um.starts_at, um.membership_plan_id, um.membership_fee_price, um.base_price,
  um.free_months, um.paid_months, um.bonus_months, um.pay_beforehand_months,
  p.free_months AS plan_free_months,
  p.paid_months AS plan_paid_months,
  p.bonus_months AS plan_bonus_months,
  p.pay_beforehand_months AS plan_pay_beforehand_months,
  ${HAS_BILLING_SNAPSHOT_SQL} AS has_billing_snapshot`;

/** The row shape `MEMBERSHIP_FEE_COLUMNS` produces. */
export interface MembershipFeeRow {
  id: number;
  /** The contract's anchor — every Billing & Duration boundary is counted from it. */
  starts_at: Date | string;
  membership_plan_id: number | null;
  /** The assignment's own regular fee (§13). NULL for a row that captured no snapshot. */
  membership_fee_price: string | number | null;
  /** Only read when the Plan has no price window either; 0 for anything created since migration 058. */
  base_price?: string | number | null;
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  pay_beforehand_months: number | null;
  plan_free_months: number | null;
  plan_paid_months: number | null;
  plan_bonus_months: number | null;
  plan_pay_beforehand_months: number | null;
  has_billing_snapshot: number;
  /** Optional: when present, `nextPricingDate()` prices the cycle it names. */
  next_billing_date?: Date | string | null;
}

/** What the Membership Fee costs on one date, and why it differs from the regular fee. */
export interface PricedMembershipFee {
  /** Never negative, and 0 exactly when `waived`. What a charge for this cycle is worth. */
  amount: number;
  /** The regular (pre-Promotion, pre-waiver) fee the amount was resolved from. */
  regular: number;
  /** Nothing is owed: no provider call, no `payment_requests` row. */
  waived: boolean;
  /**
   * Which period waived it (`free_plan`, `prepaid_plan`, `bonus_promotion`, …),
   * or `null` when the resolved amount is simply the price of a normal cycle.
   */
  periodStatus: PlanDurationStatus | PromotionTimelineStatus | null;
}

// mysql2 may return DATE columns as Date objects rather than strings depending on
// the connection's timezone config — the resolver compares dates as strings.
export function toDateOnly(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The Billing & Duration this assignment bills on: the months frozen onto it,
 * or — only when it captured no snapshot at all — its Plan's live ones. Falling
 * back column by column would be wrong: the columns are nullable, so a Free
 * Period *added to the Plan later* would waive a cycle of an assignment that
 * already exists (§13).
 */
export function assignmentPlanDuration(row: MembershipFeeRow): PlanDuration {
  return Number(row.has_billing_snapshot) === 1
    ? toPlanDuration(row.free_months, row.paid_months, row.bonus_months, row.pay_beforehand_months)
    : toPlanDuration(row.plan_free_months, row.plan_paid_months, row.plan_bonus_months, row.plan_pay_beforehand_months);
}

/**
 * The cycle an assignment's *current* price speaks for: the next one it will
 * actually be charged.
 *
 * Never a date already past, even when `next_billing_date` is (an assignment
 * whose run was missed, or a fixture): a screen asking "what does this member pay
 * now" must not be answered with a cycle from before the Promotion it just had
 * applied. And never before `starts_at` — nothing is waived, or discounted,
 * before the contract it belongs to begins.
 */
export function nextPricingDate(row: MembershipFeeRow, today = new Date().toISOString().slice(0, 10)): string {
  const startsAt = toDateOnly(row.starts_at);
  const next = row.next_billing_date != null ? toDateOnly(row.next_billing_date) : startsAt;
  const date = next > today ? next : today;
  return date > startsAt ? date : startsAt;
}

/** Shapes standing applications for the resolver. The fee engine reads no grants. */
function feePromotions(applications: { status: string }[]): SimulationPromotion[] {
  return (applications as any[])
    .filter((a) => a.status === 'applied')
    .map((a) => ({
      name: a.name,
      appliedAt: a.appliedAt,
      revokedAt: a.revokedAt,
      freeMonths: a.freeMonths,
      paidMonths: a.paidMonths,
      payBeforehandMonths: a.payBeforehandMonths,
      bonusMonths: a.bonusMonths,
      membershipFeeBenefits: a.membershipFeeBenefits,
      // Only the Membership Fee is priced here; a Promotion's granted Sellable
      // Items are the Billing Simulation's other streams.
      grants: [],
    }));
}

function price(regular: number, date: string, context: MembershipFeeContext): PricedMembershipFee {
  const resolved = resolveMembershipFee(regular, date, context);
  const amount = round2(Math.max(0, resolved.amount));
  const waiver = resolved.benefits.find((b) => b.action === 'waive');
  return {
    amount,
    regular: round2(Math.max(0, regular)),
    // A €0 cycle is never handed to a payment provider — there is nothing to
    // authorize — whether a period waived it or the benefits priced it at zero.
    waived: amount === 0,
    periodStatus: (waiver?.period_status ?? null) as PricedMembershipFee['periodStatus'],
  };
}

/**
 * What one assignment's Membership Fee costs on `date`.
 *
 * Only applications that are still **standing** (`status = 'applied'`) are
 * consulted: a revoked application's window has closed, and the cycles it
 * governed while it stood are already in the ledger.
 */
export async function priceMembershipFeeOn(
  gymId: string, row: MembershipFeeRow, date: string, conn: Tx = db,
): Promise<PricedMembershipFee> {
  return (await priceMembershipFeesOn(gymId, [row], () => date, conn)).get(row.id)!;
}

/**
 * The same answer for many assignments at once — one query for every standing
 * application, one price-window lookup per (Plan, date) pair — so a list page
 * costs a bounded number of queries rather than one per row.
 *
 * `dateFor` picks the cycle each row is priced on; pass `nextPricingDate` for
 * "what does this member pay now".
 */
export async function priceMembershipFeesOn(
  gymId: string,
  rows: MembershipFeeRow[],
  dateFor: (row: MembershipFeeRow) => string,
  conn: Tx = db,
): Promise<Map<number, PricedMembershipFee>> {
  const resolvers = await loadMembershipFeeResolvers(gymId, rows, conn);
  const priced = new Map<number, PricedMembershipFee>();
  for (const row of rows) {
    priced.set(row.id, resolvers.get(row.id)!.priceOn(dateFor(row)));
  }
  return priced;
}

/** A loaded fee context: prices any date of one assignment, without further reads. */
export interface MembershipFeeResolver {
  /** The assignment's own regular fee, before any Promotion or waiver. */
  regular: number;
  priceOn: (date: string) => PricedMembershipFee;
}

/**
 * The fee context of one assignment, for a caller that prices several dates of it
 * (the Member's upcoming payments). Loaded once; `priceOn` is then pure.
 */
export async function loadMembershipFeeResolver(
  gymId: string, row: MembershipFeeRow,
): Promise<MembershipFeeResolver> {
  return (await loadMembershipFeeResolvers(gymId, [row])).get(row.id)!;
}

/**
 * The same for many assignments, in a bounded number of queries — for a caller
 * that prices several dates of *each* of them (the Payments dashboard projects
 * five cycles per active assignment). One query for every standing application,
 * one price-window lookup per (Plan, start date) pair, then pure arithmetic.
 */
export async function loadMembershipFeeResolvers(
  gymId: string, rows: MembershipFeeRow[], conn: Tx = db,
): Promise<Map<number, MembershipFeeResolver>> {
  const resolvers = new Map<number, MembershipFeeResolver>();
  if (rows.length === 0) return resolvers;

  const applications = await loadPromotionApplicationsFor(gymId, rows.map((r) => r.id), conn);
  const feeCache = new Map<string, Promise<number | null>>();
  for (const row of rows) {
    const startsAt = toDateOnly(row.starts_at);
    const regular = (await regularMembershipFee(gymId, row, startsAt, feeCache)) ?? 0;
    const context: MembershipFeeContext = {
      startsAt,
      planDuration: assignmentPlanDuration(row),
      promotions: feePromotions(applications.get(row.id) ?? []),
    };
    resolvers.set(row.id, {
      regular: round2(Math.max(0, regular)),
      priceOn: (date) => price(regular, date, context),
    });
  }
  return resolvers;
}

/**
 * The Membership Fee an assignment owes *now*, read by id — for a caller that
 * holds nothing but the id (creating a payment request, answering an apply or
 * revoke). `null` when the assignment is not this gym's.
 */
export async function priceMembershipFeeNow(
  gymId: string, umId: number, conn: Tx = db,
): Promise<PricedMembershipFee | null> {
  const { rows } = await conn.query<MembershipFeeRow>(
    `SELECT ${MEMBERSHIP_FEE_COLUMNS}, um.next_billing_date
       FROM user_memberships um
       LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
      WHERE um.id = ? AND um.gym_id = ?`,
    [umId, gymId],
  );
  if (rows.length === 0) return null;
  return priceMembershipFeeOn(gymId, rows[0], nextPricingDate(rows[0]), conn);
}
