import { loadPromotionApplications, regularMembershipFee } from './user-memberships';
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
 * #635 stage 12 closes the §16 gap stage 11 left: `final_price` carries no date,
 * so a Promotion whose Membership Fee Benefit has run out kept discounting every
 * later cycle. The three paths that priced a fee now agree on one rule — a
 * Promotion's benefit ends with the Promotion's own Free/Paid/Bonus timeline (the
 * thread's stage 12 answer (a)) — and the run prices each cycle through it
 * instead of charging `final_price` flat.
 *
 * That correction can *raise* what a member whose promotional months already
 * elapsed is charged, so it is switchable and seeded **off**
 * (`billing.date_aware_membership_fee`, migration 186). While it is off the run
 * charges exactly what it charged before, and reports the difference it would
 * have charged instead: `priceDueMembershipFee` returns both numbers, the run
 * logs every assignment that differs and counts them in its response, and
 * `GET /user-memberships/membership-fee-drift` lists them for staff. Nothing
 * moves silently.
 */

/** The columns `POST /billing/run` reads for one assignment that is due. */
export interface DueAssignmentRow {
  id: number;
  gym_id: string;
  /** The contract's anchor — every Billing & Duration boundary is counted from it. */
  starts_at: Date | string;
  /** The agreed price after Promotions, recomputed at every apply/revoke. */
  final_price: string | number | null;
  /**
   * The regular Membership Fee frozen at assignment time (§13) — what the
   * corrected pricing starts from, since `final_price` already has the Promotions
   * baked in. NULL for an assignment that captured no snapshot, which resolves
   * through `regularMembershipFee()`'s fallback chain instead.
   */
  membership_fee_price: string | number | null;
  /** Its Plan — the price window that chain falls back to. */
  membership_plan_id: number | null;
  /** Only read when the two above give nothing; 0 for anything created since migration 058. */
  base_price: string | number | null;
  /**
   * A staff-agreed discount on this assignment's own fee, and when it lapses.
   * `final_price` carries that agreement, so while it is in force it — not the
   * catalogue fee — is the price the corrected rule discounts from: a correction
   * about *Promotions* must never quietly undo a discount a human agreed.
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

/** What to charge on a given billing date, and why it is not the agreed price. */
export interface DueMembershipFee {
  /** Never negative, and 0 exactly when `waived`. What the run actually charges. */
  amount: number;
  /** Nothing is owed: no provider call, no transaction — a ledger row and the next date. */
  waived: boolean;
  /**
   * Which period waived it (`free_plan`, `bonus_promotion`, …), or `null` when
   * the agreed price was charged (or when the assignment simply owes nothing).
   * Stored on the ledger row, so a €0 cycle says which agreement made it free.
   */
  periodStatus: PlanDurationStatus | PromotionTimelineStatus | null;
  /**
   * #635 stage 12 — what the corrected (date-aware) rule prices this cycle at.
   * Equal to `amount` once `billing.date_aware_membership_fee` is on; while it is
   * off this is the amount the run *would* have charged, which is how the drift
   * is reported without charging it.
   */
  resolvedAmount: number;
  /** `resolvedAmount - amount`, rounded to cents. 0 when the two rules agree. */
  drift: number;
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
    ? toPlanDuration(row.free_months, row.paid_months, row.bonus_months, row.pay_beforehand_months)
    : toPlanDuration(row.plan_free_months, row.plan_paid_months, row.plan_bonus_months, row.plan_pay_beforehand_months);
}

/**
 * The Membership Fee owed by `row` on `billingDate`, under both rules.
 *
 * Only applications that are still **standing** (`status = 'applied'`) are
 * consulted: a revoked application's window has closed, and the cycles it
 * governed while it stood are already in the ledger.
 *
 * `resolvedAmount` is the corrected price — `resolveMembershipFee` over the
 * assignment's *regular* fee, so a Promotion's Membership Fee Benefit applies
 * only inside the Promotion's own Free/Paid/Bonus timeline. `amount` is what the
 * run charges: the same number once `billing.date_aware_membership_fee` is on,
 * and the pre-stage-12 one (`final_price`, waived where a period waives it)
 * while it is off.
 */
export async function priceDueMembershipFee(
  row: DueAssignmentRow, billingDate: string, dateAware: boolean,
): Promise<DueMembershipFee> {
  const agreed = row.final_price != null ? Number(row.final_price) : 0;
  // The regular (pre-Promotion) fee the corrected rule discounts from, resolved
  // by the one chain every other path uses. A manual discount that is still in
  // force outranks it: `final_price` carries that agreement, so this correction —
  // which is about Promotions — can only ever charge a manually-discounted
  // assignment less than it does today, never more.
  const startsAt = toDateOnly(row.starts_at);
  const manualDiscount = row.discount_reason != null
    && (row.discount_expires_at == null || toDateOnly(row.discount_expires_at) >= billingDate);
  const regular = manualDiscount
    ? agreed
    : (await regularMembershipFee(row.gym_id, row, startsAt)) ?? agreed;

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
    startsAt,
    planDuration: durationForRow(row),
    promotions,
  };

  const corrected = resolveMembershipFee(regular, billingDate, context);
  const resolvedAmount = round2(Math.max(0, corrected.amount));
  const waiver = corrected.benefits.find((b) => b.action === 'waive');
  const periodStatus = (waiver?.period_status ?? null) as DueMembershipFee['periodStatus'];

  if (dateAware) {
    return {
      amount: resolvedAmount,
      // A €0 cycle is never handed to the payment provider — there is nothing to
      // authorize, and a provider that rejects a zero-amount MIT would put a
      // failure on the ledger for a cycle that owed nothing. It is waived
      // whether a period waived it or the benefits simply priced it at zero.
      waived: resolvedAmount === 0,
      periodStatus,
      resolvedAmount,
      drift: 0,
    };
  }

  // The pre-stage-12 amount: `final_price` flat, waived only where a Free
  // Period, Bonus Duration or free/bonus promotional month covers the date
  // (stage 11). Passing the agreed price in as the regular one is deliberate
  // there: that call decided *whether* the cycle was waived, never its price.
  const legacy = resolveMembershipFee(agreed, billingDate, context);
  const legacyWaiver = legacy.benefits.find((b) => b.action === 'waive');
  const amount = !(agreed > 0) || legacyWaiver ? 0 : agreed;
  return {
    amount,
    waived: amount === 0,
    periodStatus: (legacyWaiver?.period_status ?? null) as DueMembershipFee['periodStatus'],
    resolvedAmount,
    drift: round2(resolvedAmount - amount),
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
