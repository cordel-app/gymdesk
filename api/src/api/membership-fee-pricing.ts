import { db } from '../infra/db';
import { PromotionApplication, loadPromotionApplicationsFor, regularMembershipFee } from './user-memberships';
import {
  MembershipFeeContext,
  SimulationPromotion,
  resolveMembershipFee,
} from '../domain/billingSimulation';
import { PlanDurationStatus, toPlanDuration } from '../domain/planDuration';
import { PromotionTimelineStatus } from '../domain/promotionTimeline';

/**
 * What the Membership Fee costs on a given date, for one assignment — the single
 * answer every money-moving and money-displaying path in the API reads.
 *
 * ── How it got here ───────────────────────────────────────────────────────────
 *
 * #635 stage 11 stopped `POST /billing/run` charging a cycle the contract waives:
 * a Plan sold with a one-month Free Period showed €0 on the staff screens and on
 * My Membership, and was charged that night anyway, because the run took
 * `user_memberships.final_price` flat.
 *
 * Stage 12 closed the other half of the same gap. `final_price` was a single
 * number with no date in it, recomputed at every promotion apply/revoke, so a
 * Promotion whose Membership Fee Benefit had run out kept discounting every later
 * cycle. One rule now decides the price of a cycle — an applied Promotion's
 * benefit lives inside the Promotion's own Free/Paid/Bonus timeline and ends with
 * it (the thread's stage 12 answer (a)) — and it lives in
 * `resolveMembershipFee()`, the Billing Simulation's own resolver, so the run
 * cannot disagree with what the Member was shown. That includes its precedence
 * rule, *"in case of conflict, prioritize the promotion"* (the thread's Q2
 * answer): where a Promotion governs the date it decides alone and the Plan's
 * Free Period does not also apply.
 *
 * #635 stage 15 removes the last of the old shape. The correction shipped behind
 * `billing.date_aware_membership_fee` so its impact could be reviewed before it
 * moved money; the review's answer was to make it standard and delete the stored
 * number outright, so there is no flag, no legacy branch and no `final_price`
 * column any more. Pricing a cycle is now the *only* way to know what an
 * assignment owes, which is why this module is shared rather than the billing
 * run's private helper: the nightly run, the Payments dashboard's projected
 * rows, a staff- or member-initiated payment request, the Assigned Plans list
 * and the Member's own page all price the same date through the same call.
 */

/** The columns every caller has to read for one assignment. Aliases: `um`, `p`. */
export const FEE_ASSIGNMENT_COLUMNS = `
  um.id, um.gym_id, um.starts_at, um.next_billing_date,
  um.membership_fee_price, um.membership_plan_id, um.base_price,
  um.discount_reason, um.discount_expires_at,
  um.free_months, um.paid_months, um.bonus_months, um.pay_beforehand_months,
  p.free_months AS plan_free_months,
  p.paid_months AS plan_paid_months,
  p.bonus_months AS plan_bonus_months,
  p.pay_beforehand_months AS plan_pay_beforehand_months,
  (um.free_months IS NOT NULL OR um.paid_months IS NOT NULL OR um.pay_beforehand_months IS NOT NULL
   OR um.bonus_months IS NOT NULL OR um.recurring_billing_interval IS NOT NULL
   OR um.recurring_billing_unit IS NOT NULL OR um.membership_fee_price IS NOT NULL
  ) AS has_billing_snapshot`;

/** The FROM/JOIN `FEE_ASSIGNMENT_COLUMNS` resolves against. */
export const FEE_ASSIGNMENT_FROM = `
  FROM user_memberships um
  LEFT JOIN membership_plans p ON p.id = um.membership_plan_id`;

/** One assignment, as much of it as pricing a Membership Fee needs. */
export interface FeeAssignmentRow {
  id: number;
  gym_id: string;
  /** The contract's anchor — every Billing & Duration boundary is counted from it. */
  starts_at: Date | string;
  /** The cycle the assignment is next charged for; null once it bills nothing further. */
  next_billing_date: Date | string | null;
  /**
   * The regular Membership Fee frozen at assignment time (§13) — the number every
   * Promotion benefit discounts *from*. NULL for an assignment that captured no
   * snapshot, which resolves through `regularMembershipFee()`'s fallback chain.
   */
  membership_fee_price: string | number | null;
  /** Its Plan — the price window that chain falls back to. */
  membership_plan_id: number | null;
  /** Only read when the two above give nothing; 0 for anything created since migration 058. */
  base_price: string | number | null;
  /**
   * A negotiated fee on this assignment, and when it was agreed to lapse. While
   * it is in force the frozen fee *is* the agreement, so a correction about
   * *Promotions* can never quietly undo it; once `discount_expires_at` is past,
   * the assignment falls back to its Plan's price window exactly as it did
   * before stage 15 (when the negotiated number lived in `final_price`).
   */
  discount_reason: string | null;
  discount_expires_at: Date | string | null;
  /** The assignment's own frozen Billing & Duration (migration 174). */
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  pay_beforehand_months: number | null;
  /** Its Plan's live ones — the fallback for an assignment that captured nothing. */
  plan_free_months: number | null;
  plan_paid_months: number | null;
  plan_bonus_months: number | null;
  plan_pay_beforehand_months: number | null;
  /** 1 when any of the seven snapshot columns is set; decides that fallback. */
  has_billing_snapshot: number;
}

/** What is owed on a given billing date, and why it is not the regular fee. */
export interface DueMembershipFee {
  /** Never negative, and 0 exactly when `waived`. What the run actually charges. */
  amount: number;
  /** Nothing is owed: no provider call, no transaction — a ledger row and the next date. */
  waived: boolean;
  /**
   * Which period waived it (`free_plan`, `bonus_promotion`, …), or `null` when the
   * fee was charged (or when the assignment simply owes nothing). Stored on the
   * ledger row, so a €0 cycle says which agreement made it free.
   */
  periodStatus: PlanDurationStatus | PromotionTimelineStatus | null;
}

// mysql2 may return DATE columns as Date objects rather than strings depending
// on the connection's timezone config (same note as user-memberships.ts) — the
// resolver compares dates as strings.
function toDateOnly(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

/**
 * The Billing & Duration this assignment bills on: the months frozen onto it,
 * or — only when it captured no snapshot at all — its Plan's live ones. The
 * same all-or-nothing rule `billing-simulation.ts` applies, and for the same
 * reason: the columns are nullable, so falling back column by column would let
 * a Free Period *added to the Plan later* waive a cycle of an assignment that
 * already exists (§13).
 */
function durationForRow(row: FeeAssignmentRow) {
  return Number(row.has_billing_snapshot) === 1
    ? toPlanDuration(row.free_months, row.paid_months, row.bonus_months, row.pay_beforehand_months)
    : toPlanDuration(row.plan_free_months, row.plan_paid_months, row.plan_bonus_months, row.plan_pay_beforehand_months);
}

/**
 * The date "what this member pays now" means: the next cycle they will actually
 * be charged for.
 *
 * Never a date already past, even when `next_billing_date` is (an assignment
 * whose run was missed, or a fixture) — a screen asked for today's price would
 * otherwise report a discount from a cycle before the Promotion was applied. And
 * never before `starts_at`: nothing is waived, or discounted, before the
 * contract it belongs to begins.
 */
export function currentCycleDate(row: Pick<FeeAssignmentRow, 'starts_at' | 'next_billing_date'>): string {
  const startsAt = toDateOnly(row.starts_at);
  const today = new Date().toISOString().slice(0, 10);
  const next = row.next_billing_date != null ? toDateOnly(row.next_billing_date) : startsAt;
  const date = next > today ? next : today;
  return date > startsAt ? date : startsAt;
}

/**
 * The Membership Fee `row` owes on `billingDate`.
 *
 * Only applications that are still **standing** (`status = 'applied'`) are
 * consulted: a revoked application's window has closed, and the cycles it
 * governed while it stood are already in the ledger.
 */
export async function priceMembershipFeeOn(
  row: FeeAssignmentRow, billingDate: string,
): Promise<DueMembershipFee> {
  const applications = await loadPromotionApplicationsFor(row.gym_id, [row.id]);
  return priceWithApplications(row, billingDate, applications.get(row.id) ?? []);
}

/**
 * The same rule, over many assignments and dates at once: one query for every
 * row's standing applications instead of one per row. A list that shows what
 * each member pays (the Assigned Plans page, the Payments dashboard's projected
 * rows) prices dozens of cycles, and the per-row loader turns that into hundreds
 * of round trips.
 */
export async function priceMembershipFeesFor<T extends FeeAssignmentRow>(
  rows: T[], dateFor: (row: T) => string[],
): Promise<Map<number, Map<string, DueMembershipFee>>> {
  const out = new Map<number, Map<string, DueMembershipFee>>();
  if (rows.length === 0) return out;
  const applications = await loadPromotionApplicationsFor(rows[0].gym_id, rows.map((r) => r.id));
  for (const row of rows) {
    const perDate = new Map<string, DueMembershipFee>();
    for (const date of dateFor(row)) {
      perDate.set(date, await priceWithApplications(row, date, applications.get(row.id) ?? []));
    }
    out.set(row.id, perDate);
  }
  return out;
}

async function priceWithApplications(
  row: FeeAssignmentRow, billingDate: string, applications: PromotionApplication[],
): Promise<DueMembershipFee> {
  const startsAt = toDateOnly(row.starts_at);
  // A negotiated fee that has lapsed stops outranking the catalogue: skip the
  // frozen number and resolve the Plan's price window, which is what the
  // pre-stage-15 code did once `discount_expires_at` was past.
  const lapsed = row.discount_reason != null && String(row.discount_reason).trim() !== ''
    && row.discount_expires_at != null && toDateOnly(row.discount_expires_at) < billingDate;
  const regular = (await regularMembershipFee(row.gym_id, row, startsAt, { ignoreFrozenFee: lapsed })) ?? 0;

  const promotions: SimulationPromotion[] = applications
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
      // Items are the simulation's other streams and are charged by nothing here.
      grants: [],
    }));

  const context: MembershipFeeContext = {
    startsAt,
    planDuration: durationForRow(row),
    promotions,
  };

  const resolved = resolveMembershipFee(regular, billingDate, context);
  const amount = round2(Math.max(0, resolved.amount));
  const waiver = resolved.benefits.find((b) => b.action === 'waive');
  return {
    amount,
    // A €0 cycle is never handed to the payment provider — there is nothing to
    // authorize, and a provider that rejects a zero-amount MIT would put a
    // failure on the ledger for a cycle that owed nothing. It is waived whether
    // a period waived it or the benefits simply priced it at zero.
    waived: amount === 0,
    periodStatus: (waiver?.period_status ?? null) as DueMembershipFee['periodStatus'],
  };
}

/** One assignment's pricing row, or null when it is not this gym's. */
export async function loadFeeAssignment(gymId: string, umId: number): Promise<FeeAssignmentRow | null> {
  const { rows } = await db.query<FeeAssignmentRow>(
    `SELECT ${FEE_ASSIGNMENT_COLUMNS} ${FEE_ASSIGNMENT_FROM}
      WHERE um.id = ? AND um.gym_id = ?`,
    [umId, gymId],
  );
  return rows[0] ?? null;
}

/** Many assignments' pricing rows in one query, keyed by id. */
export async function loadFeeAssignments(gymId: string, umIds: number[]): Promise<Map<number, FeeAssignmentRow>> {
  const out = new Map<number, FeeAssignmentRow>();
  const ids = [...new Set(umIds)];
  if (ids.length === 0) return out;
  const { rows } = await db.query<FeeAssignmentRow>(
    `SELECT ${FEE_ASSIGNMENT_COLUMNS} ${FEE_ASSIGNMENT_FROM}
      WHERE um.gym_id = ? AND um.id IN (${ids.map(() => '?').join(',')})`,
    [gymId, ...ids],
  );
  for (const row of rows) out.set(Number(row.id), row);
  return out;
}

/**
 * What each of these assignments is charged for its own current cycle, keyed by
 * id — two queries for the whole list, whatever its length.
 */
export async function currentMembershipFees(
  gymId: string, umIds: number[],
): Promise<Map<number, number>> {
  const rows = [...(await loadFeeAssignments(gymId, umIds)).values()];
  const priced = await priceMembershipFeesFor(rows, (row) => [currentCycleDate(row)]);
  const out = new Map<number, number>();
  for (const row of rows) {
    const amount = priced.get(row.id)?.get(currentCycleDate(row))?.amount;
    if (amount != null) out.set(row.id, amount);
  }
  return out;
}

/**
 * What this assignment is charged for its current cycle — the number that used
 * to be read straight off `final_price`, now resolved on
 * `currentCycleDate()`. `null` only when the assignment does not exist.
 */
export async function currentMembershipFee(gymId: string, umId: number): Promise<number | null> {
  const row = await loadFeeAssignment(gymId, umId);
  if (!row) return null;
  return (await priceMembershipFeeOn(row, currentCycleDate(row))).amount;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
