import {
  MEMBERSHIP_FEE_COLUMNS,
  MembershipFeeRow,
  PricedMembershipFee,
  priceMembershipFeeOn,
} from './membership-fee-pricing';

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
 * or bonus month, which that column (a single number, recomputed at every
 * apply/revoke) had no way to express.
 *
 * What this module decides is therefore exactly one thing: **what does the
 * assignment owe on the date being billed?** The answer comes from
 * `priceMembershipFeeOn`, the one resolver every other surface reads, so the run
 * cannot disagree with what the Member was shown — including its precedence rule,
 * "in case of conflict, prioritize the promotion" (the thread's Q2 answer): where
 * a Promotion governs the date, the Promotion decides alone and the Plan's Free
 * Period does not also apply.
 *
 * #635 stage 12 closed the §16 gap: a Promotion's Membership Fee Benefit ends
 * with the Promotion's own Free/Paid/Bonus timeline (the thread's stage 12 answer
 * (a)), so the run prices each cycle through that rule instead of charging a
 * stored number. Stage 15 finished it — the stored number and the
 * `billing.date_aware_membership_fee` switch that guarded the correction are both
 * gone (migration 191), because with nothing stored there is no second rule left
 * to drift from.
 */

/** The columns `POST /billing/run` reads for one assignment that is due. */
export type DueAssignmentRow = MembershipFeeRow;

/** The SELECT list the run needs to price an assignment (`um` joined to `p`). */
export const DUE_ASSIGNMENT_FEE_COLUMNS = MEMBERSHIP_FEE_COLUMNS;

/** What to charge on a given billing date, and why it is not the regular price. */
export type DueMembershipFee = PricedMembershipFee;

/**
 * The Membership Fee `row` owes on `billingDate`.
 *
 * Only applications that are still **standing** (`status = 'applied'`) are
 * consulted: a revoked application's window has closed, and the cycles it
 * governed while it stood are already in the ledger. A cycle that comes to €0 —
 * a Free Period, a Pre-paid or Bonus Duration, a Promotion's free month, or a
 * benefit that prices it at zero — is `waived`: the provider is never called for
 * it, because there is nothing to authorize.
 */
export async function priceDueMembershipFee(
  row: DueAssignmentRow, billingDate: string, gymId: string,
): Promise<DueMembershipFee> {
  return priceMembershipFeeOn(gymId, row, billingDate);
}
