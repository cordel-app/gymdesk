import { loadPromotionApplications } from './user-memberships';
import {
  MembershipFeeContext,
  SimulationPromotion,
  resolveMembershipFee,
} from '../domain/billingSimulation';
import { PlanDurationStatus, toPlanDuration } from '../domain/planDuration';
import { PromotionTimelineStatus } from '../domain/promotionTimeline';

/**
 * #635 stage 11 — the nightly billing run stops charging a waived cycle.
 *
 * Stage 1 gave a Membership Plan its Billing & Duration, stage 2 froze it onto
 * every assignment and stage 8 made the Billing Simulation bill from it: a Plan
 * sold with a one-month Free Period shows €0 for that month, on the staff
 * screens and — since stage 10 — on the Member's own My Membership page.
 *
 * `POST /billing/run` never read any of it. It charged
 * `user_memberships.final_price` flat, so the member was shown a free month and
 * charged for it that night. The same held for an applied Promotion's own free
 * or bonus month, which `final_price` (a single number, recomputed at every
 * apply/revoke — `computeFinalPrice` in `membership-promotions.ts`) has no way
 * to express.
 *
 * What this module decides is therefore exactly one thing: **is the fee waived
 * on the date being billed?** The answer comes from `resolveMembershipFee`, the
 * simulation's own resolver, so the run cannot disagree with what the Member was
 * shown — including its precedence rule, "in case of conflict, prioritize the
 * promotion" (the thread's Q2 answer): where a Promotion governs the date, the
 * Promotion decides alone and the Plan's Free Period does not also apply.
 *
 * **Everything else is charged exactly as before**, `final_price` and all. The
 * remaining §16 gap — `final_price` carries no date, so a Promotion's Membership
 * Fee Benefit that has run out keeps discounting later cycles — is deliberately
 * left alone here: closing it means reconciling `computeFinalPrice`, the
 * simulation engine and `computeMembershipFeePriceAt`, which disagree about a
 * Promotion configured with a fee benefit and no Free/Paid/Bonus months at all.
 * Charging a member *more* than the agreed price on the strength of that
 * disagreement is not something a billing run should decide by itself.
 */

/** The columns `POST /billing/run` reads for one assignment that is due. */
export interface DueAssignmentRow {
  id: number;
  gym_id: string;
  /** The contract's anchor — every Billing & Duration boundary is counted from it. */
  starts_at: Date | string;
  /** The agreed price after Promotions, recomputed at every apply/revoke. */
  final_price: string | number | null;
  /** The assignment's own frozen Billing & Duration (migration 174). */
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  /** Its Plan's live ones — the fallback for an assignment that captured nothing. */
  plan_free_months: number | null;
  plan_paid_months: number | null;
  plan_bonus_months: number | null;
  /** 1 when any of the six snapshot columns is set; decides that fallback. */
  has_billing_snapshot: number;
}

/** What to charge on a given billing date, and why it is not the agreed price. */
export interface DueMembershipFee {
  /** Never negative, and 0 exactly when `waived`. */
  amount: number;
  /** Nothing is owed: no provider call, no transaction — a ledger row and the next date. */
  waived: boolean;
  /**
   * Which period waived it (`free_plan`, `bonus_promotion`, …), or `null` when
   * the agreed price was charged (or when the assignment simply owes nothing).
   * Stored on the ledger row, so a €0 cycle says which agreement made it free.
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
function durationForRow(row: DueAssignmentRow) {
  return Number(row.has_billing_snapshot) === 1
    ? toPlanDuration(row.free_months, row.paid_months, row.bonus_months)
    : toPlanDuration(row.plan_free_months, row.plan_paid_months, row.plan_bonus_months);
}

/**
 * The Membership Fee owed by `row` on `billingDate`.
 *
 * Only applications that are still **standing** (`status = 'applied'`) are
 * consulted: a revoked application's window has closed, and the cycles it
 * governed while it stood are already in the ledger.
 */
export async function priceDueMembershipFee(
  row: DueAssignmentRow, billingDate: string,
): Promise<DueMembershipFee> {
  const agreed = row.final_price != null ? Number(row.final_price) : 0;
  // A €0 assignment is never handed to the payment provider — there is nothing
  // to authorize, and a provider that rejects a zero-amount MIT would put a
  // failure on the ledger for a cycle that owed nothing.
  if (!(agreed > 0)) return { amount: 0, waived: true, periodStatus: null };

  const applications = await loadPromotionApplications(row.gym_id, row.id);
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
      // The run bills the Membership Fee only; a Promotion's granted Sellable
      // Items are the simulation's other streams and are charged by nothing here.
      grants: [],
    }));

  const context: MembershipFeeContext = {
    startsAt: toDateOnly(row.starts_at),
    planDuration: durationForRow(row),
    promotions,
  };

  // The agreed price is passed in as the regular one deliberately: this call
  // decides *whether* the cycle is waived, not what a non-waived cycle costs.
  const charge = resolveMembershipFee(agreed, billingDate, context);
  const waiver = charge.benefits.find((b) => b.action === 'waive');
  if (!waiver) return { amount: agreed, waived: false, periodStatus: null };
  return {
    amount: 0,
    waived: true,
    periodStatus: (waiver.period_status ?? null) as DueMembershipFee['periodStatus'],
  };
}
