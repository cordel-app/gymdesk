import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext } from '../infra/tenantContext';
import { DueAssignmentRow, priceDueMembershipFee } from './billing-run-pricing';
import { loadPromotionApplications } from './user-memberships';
import { isDateAwareMembershipFeeEnabled } from '../infra/featureFlags';
import { promotionTimelineEndsOn } from '../domain/promotionTimeline';

/**
 * #635 stage 12 — the Membership Fee drift report.
 *
 * Mounted at `GET /user-memberships/reports/membership-fee-drift`.
 *
 * Stage 12 makes one rule decide what the Membership Fee costs on a date: an
 * applied Promotion's Membership Fee Benefit lives inside the Promotion's own
 * Free/Paid/Bonus timeline and ends with it (the thread's answer (a)). The
 * nightly run charged `user_memberships.final_price` instead — a single number
 * with no date in it — so a Promotion whose promotional months had elapsed kept
 * discounting every later cycle.
 *
 * Correcting that can *raise* a real charge, which the thread asked not to let
 * happen silently: "First generate a report of affected members/assignments
 * showing the current stored price, Promotion timeline, benefit end date, newly
 * resolved price, and difference." This is that report. It changes nothing — it
 * prices every assignment both ways and lists the ones that disagree, so the
 * impact can be reviewed before `billing.date_aware_membership_fee` is switched
 * on and the run starts charging the resolved price.
 *
 * Read-only end to end: no writes, no provider calls, no ledger rows.
 */

// The statuses that still have charges ahead of them. A `cancelled`/`expired`
// assignment bills nothing further, so no correction can reach it; a `draft` one
// has never been billed. Mirrors the nightly run's own `status = 'active'` plus
// `paused`, which resumes onto the same schedule.
const REPORTED_STATUSES = ['active', 'paused'] as const;

// mysql2 may return DATE columns as Date objects rather than strings depending
// on the connection's timezone config (same note as user-memberships.ts).
function toDateOnly(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

/** One applied Promotion, as the report explains an assignment's difference. */
export interface DriftPromotion {
  user_membership_promotion_id: number;
  promotion_id: number;
  name: string | null;
  applied_at: string;
  free_months: number;
  paid_months: number;
  bonus_months: number;
  /**
   * The last date this application's Promotion timeline covers — the date its
   * Membership Fee Benefit stops applying. `null` for a Promotion with no
   * Free/Paid/Bonus months at all, whose benefit therefore never applies.
   */
  benefit_ends_on: string | null;
  /** Whether it still carries an enabled Membership Fee Benefit at all. */
  has_membership_fee_benefit: boolean;
}

export interface DriftItem {
  user_membership_id: number;
  member_id: number;
  member_name: string | null;
  plan_name: string | null;
  /** The cycle priced: the assignment's next billing date, or its start date. */
  billing_date: string;
  /** `user_memberships.final_price` — the stored, date-less agreed price. */
  stored_final_price: number | null;
  /** The regular Membership Fee the corrected rule discounts from. */
  regular_fee: number | null;
  /** What the run charges for that cycle today. */
  charged_amount: number;
  /** What the corrected rule prices it at. */
  resolved_amount: number;
  /** `resolved_amount - charged_amount`: positive means the member would pay more. */
  difference: number;
  promotions: DriftPromotion[];
}

export interface MembershipFeeDriftReport {
  /** Is the corrected pricing already live? Then every difference below is 0. */
  date_aware_pricing_enabled: boolean;
  /** Assignments examined — every `active`/`paused` assignment of the gym. */
  examined: number;
  items: DriftItem[];
  /** Sum of the differences, so the report's total impact is one number. */
  total_difference: number;
}

type ReportRow = DueAssignmentRow & {
  member_id: number;
  member_name: string | null;
  plan_name: string | null;
  next_billing_date: Date | string | null;
};

export async function computeMembershipFeeDrift(gymId: string): Promise<MembershipFeeDriftReport> {
  const dateAware = await isDateAwareMembershipFeeEnabled();
  const { rows } = await db.query<ReportRow>(
    `SELECT um.id, um.gym_id, um.member_id, um.membership_plan_id,
            um.starts_at, um.next_billing_date,
            um.final_price, um.membership_fee_price, um.base_price,
            um.discount_reason, um.discount_expires_at,
            um.free_months, um.paid_months, um.bonus_months, um.pay_beforehand_months,
            p.free_months AS plan_free_months,
            p.paid_months AS plan_paid_months,
            p.bonus_months AS plan_bonus_months,
            p.pay_beforehand_months AS plan_pay_beforehand_months,
            (um.free_months IS NOT NULL OR um.paid_months IS NOT NULL OR um.pay_beforehand_months IS NOT NULL
             OR um.bonus_months IS NOT NULL OR um.recurring_billing_interval IS NOT NULL
             OR um.recurring_billing_unit IS NOT NULL OR um.membership_fee_price IS NOT NULL
            ) AS has_billing_snapshot,
            m.name AS member_name, p.name AS plan_name
     FROM user_memberships um
     JOIN members m ON m.id = um.member_id
     LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
     WHERE um.gym_id = ?
       AND um.status IN (${REPORTED_STATUSES.map(() => '?').join(',')})
     ORDER BY um.starts_at ASC, um.id ASC`,
    [gymId, ...REPORTED_STATUSES],
  );

  const items: DriftItem[] = [];
  for (const row of rows) {
    // The cycle the difference would first be charged on. `next_billing_date` is
    // what the run reads; an assignment that has none yet is priced on its own
    // start date, so a promotion already lapsed at signup still shows up.
    const billingDate = row.next_billing_date != null
      ? toDateOnly(row.next_billing_date)
      : toDateOnly(row.starts_at);
    // Priced by the run's own function, under the rule the run is actually
    // following, so the report cannot claim a number the run would not produce.
    // Once the corrected pricing is live the two agree by construction and the
    // report is empty — which is the signal that nothing is outstanding.
    const priced = await priceDueMembershipFee(row, billingDate, dateAware);
    if (priced.drift === 0) continue;

    const applications = await loadPromotionApplications(gymId, row.id);
    items.push({
      user_membership_id: row.id,
      member_id: row.member_id,
      member_name: row.member_name,
      plan_name: row.plan_name,
      billing_date: billingDate,
      stored_final_price: row.final_price != null ? Number(row.final_price) : null,
      regular_fee: row.membership_fee_price != null ? Number(row.membership_fee_price) : null,
      charged_amount: priced.amount,
      resolved_amount: priced.resolvedAmount,
      difference: priced.drift,
      promotions: applications
        .filter((a) => a.status === 'applied')
        .map((a) => ({
          user_membership_promotion_id: a.id,
          promotion_id: a.promotionId,
          name: a.name,
          applied_at: a.appliedAt,
          free_months: a.freeMonths,
          paid_months: a.paidMonths,
          bonus_months: a.bonusMonths,
          benefit_ends_on: promotionTimelineEndsOn({
            freeMonths: a.freeMonths,
            paidMonths: a.paidMonths,
            payBeforehandMonths: a.payBeforehandMonths,
            bonusMonths: a.bonusMonths,
          }, a.appliedAt),
          has_membership_fee_benefit: a.membershipFeeBenefits.some(
            (b) => b.enabled && b.action != null && b.action !== 'no_benefit',
          ),
        })),
    });
  }

  return {
    date_aware_pricing_enabled: dateAware,
    examined: rows.length,
    items,
    total_difference: Math.round(items.reduce((sum, i) => sum + i.difference, 0) * 100) / 100,
  };
}

export const membershipFeeDriftRouter = Router();

membershipFeeDriftRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  res.json(await computeMembershipFeeDrift(gymId));
});
