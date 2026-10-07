import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import { recordAudit } from '../infra/audit';
import { resolveMemberId } from './me';
import { computePriceFields } from './products';
import { selectPlanTaxRates } from '../domain/planTaxRate';
import {
  ASSIGNMENT_CREATION_STATUS, effectivePrice, planAssignabilityError,
} from './user-memberships';
import { recordStatusChange } from './billing-events';
import { snapshotAssignedPlan } from './assigned-plan-snapshot';
import { resolveDeclinedBenefits } from './declined-plan-benefits';
import { applyPromotionToMembership, validatePromotionSelection } from './membership-promotions';
import { currentMembershipFee } from './membership-fee-pricing';
import { commitAssignment, submitForPayment } from './assignment-commit';
import { activePlanConflictBody } from '../domain/oneActivePlan';
import { isNewMemberStatus } from './new-member-eligibility';
import {
  PLAN_PROMOTION_TARGET, firstCycleFinalPrice, isOfferableFeeBenefit,
} from '../domain/memberPlanCatalogue';

/**
 * #1122 §1–§6 — the Members App's **Add Plan**.
 *
 *   GET  /me/membership-plans              the plans a member may choose, each
 *                                          with the Promotions compatible with it
 *   POST /me/membership-plans/:id/assign   choose one: a Draft of the member's
 *                                          own, the chosen Promotions applied,
 *                                          then Save & Pay
 *
 * It is the staff assignment made self-service, and it invents no rule of its
 * own: which plans may be assigned is `planAssignabilityError()` (active and
 * public), which Promotions may be applied is `validatePromotionSelection()`
 * (the very validation the Assign New Plan editor runs, `only_applicable_for_new_members`
 * included), the Draft is written exactly as `POST /user-memberships` writes
 * one — snapshot, ledger row, covered member — each Promotion is applied
 * through `applyPromotionToMembership()` (its own snapshot, §6), and the
 * commit is #1108 stage 2's `submitForPayment()` / `commitAssignment()`, so
 * the member lands in the same **Pending Payment** state a staff Save & Pay
 * produces and pays it through the same *Pay now*. The member is never named
 * by a request (#1036's rule).
 *
 * The one-plan rule is the member's too: a member holding a live plan is told
 * (`409 active_plan_exists`) and confirms the replacement with `confirm: true`,
 * exactly as staff do.
 */
export const meMembershipPlansRouter = Router();

meMembershipPlansRouter.use(requireRole('member'), requireFeatureEnabled('member_web.my_membership'));

interface PlanRow {
  id: number; name: string; description: string | null;
  tax_rate_id: number | null; tax_behavior: string | null;
  billing_interval: number | null; billing_unit: string | null;
}

interface PromotionRow {
  id: number; name: string; membership_plan_id: number;
  only_applicable_for_new_members: number;
  enabled: number | null; action: string | null; value: string | null; duration_months: number | null;
}

/**
 * The Promotions compatible with each plan: about a Membership Plan
 * (`applies_to`, #926's first reader after #1118), active, inside their window
 * (compared in SQL so no DATETIME crosses a timezone conversion), targeting
 * the plan, and — for one restricted to new members — only while this member
 * qualifies (#927's Member-level answer).
 */
async function loadCompatiblePromotions(gymId: string, planIds: number[], isNewMember: boolean) {
  if (planIds.length === 0) return new Map<number, PromotionRow[]>();
  const marks = planIds.map(() => '?').join(',');
  const { rows } = await db.query<PromotionRow>(
    `SELECT p.id, p.name, pmp.membership_plan_id, p.only_applicable_for_new_members,
            b.enabled, b.action, b.value, b.duration_months
       FROM promotions p
       JOIN promotion_membership_plans pmp ON pmp.promotion_id = p.id AND pmp.gym_id = p.gym_id
       LEFT JOIN promotion_membership_fee_benefits b ON b.promotion_id = p.id
      WHERE p.gym_id = ? AND p.applies_to = ? AND p.lifecycle_status = 'active'
        AND p.starts_at <= UTC_TIMESTAMP() AND p.ends_at >= UTC_TIMESTAMP()
        AND pmp.membership_plan_id IN (${marks})
      ORDER BY p.name ASC`,
    [gymId, PLAN_PROMOTION_TARGET, ...planIds],
  );
  const byPlan = new Map<number, PromotionRow[]>();
  for (const row of rows) {
    if (Number(row.only_applicable_for_new_members) === 1 && !isNewMember) continue;
    if (!isOfferableFeeBenefit(row)) continue;
    const list = byPlan.get(Number(row.membership_plan_id)) ?? [];
    list.push(row);
    byPlan.set(Number(row.membership_plan_id), list);
  }
  return byPlan;
}

meMembershipPlansRouter.get('/', async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId } = ctx;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const today = new Date().toISOString().slice(0, 10);
    const { rows: plans } = await db.query<PlanRow>(
      `SELECT mp.id, mp.name, mp.description, mp.tax_rate_id, mp.tax_behavior,
              bp.recurring_billing_interval AS billing_interval,
              bp.recurring_billing_unit AS billing_unit
         FROM membership_plans mp
         LEFT JOIN billing_policies bp ON bp.membership_plan_id = mp.id AND bp.gym_id = mp.gym_id
        WHERE mp.gym_id = ? AND mp.deleted_at IS NULL
          AND mp.lifecycle_status = 'active' AND mp.enrollment_status = 'public'
        ORDER BY mp.name ASC`,
      [gymId],
    );
    const { rows: taxRateRows } = await db.query<any>(
      'SELECT id, name, rate_percent, is_system, deleted_at FROM tax_rates WHERE gym_id = ?',
      [gymId],
    );
    const isNewMember = await isNewMemberStatus(db, gymId, memberId);
    const promotions = await loadCompatiblePromotions(gymId, plans.map((p) => Number(p.id)), isNewMember);

    const items = [];
    for (const plan of plans) {
      const eff = await effectivePrice(Number(plan.id), gymId, today);
      const { effective: taxRate } = selectPlanTaxRates(taxRateRows, plan.tax_rate_id);
      const priceFields = computePriceFields({
        amount: eff ? eff.price : null,
        tax_rate_percent: taxRate ? taxRate.rate_percent : null,
        tax_behavior: plan.tax_behavior,
      });
      // The VAT-inclusive figure, or the stored amount for a gym with no tax
      // rate at all — `formatPlanCurrentPrice()`'s own fallback (#817).
      const priceInclTax = priceFields.amount_incl_tax ?? (eff ? Math.round(eff.price * 100) / 100 : null);
      items.push({
        id: Number(plan.id),
        name: plan.name,
        description: plan.description,
        price_incl_tax: priceInclTax,
        tax_included: priceFields.amount_incl_tax != null,
        billing_interval: plan.billing_interval != null ? Number(plan.billing_interval) : null,
        billing_unit: plan.billing_unit,
        promotions: (promotions.get(Number(plan.id)) ?? []).map((p) => ({
          id: Number(p.id),
          name: p.name,
          benefit: { action: p.action, value: p.value != null ? Number(p.value) : null },
          duration_months: p.duration_months != null ? Number(p.duration_months) : null,
          final_price_incl_tax: priceInclTax != null ? firstCycleFinalPrice(priceInclTax, p) : null,
        })),
      });
    }
    res.json({ plans: items, is_new_member: isNewMember });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

function parseIds(raw: unknown): number[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const ids: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}

meMembershipPlansRouter.post('/:id/assign', async (req, res, next) => {
  const ctx = getTenantContext(req);
  const { gymId, userId } = ctx;
  const planId = Number(req.params.id);
  if (!Number.isInteger(planId) || planId <= 0) return res.status(400).json({ error: 'Invalid id' });
  const promotionIds = parseIds(req.body?.promotion_ids);
  if (promotionIds === null) return res.status(400).json({ error: 'promotion_ids must be an array of positive integers' });
  const confirm = req.body?.confirm === true;
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows: memberRows } = await db.query<{ name: string }>(
      'SELECT name FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL', [memberId, gymId],
    );
    if (!memberRows[0]) return res.status(404).json({ error: 'Member profile not found' });

    const planError = await planAssignabilityError(gymId, planId);
    if (planError) return res.status(planError.status).json({ error: planError.error });
    const startsAt = new Date().toISOString().slice(0, 10);
    const eff = await effectivePrice(planId, gymId, startsAt);
    if (!eff) return res.status(404).json({ error: 'Plan not found' });

    // §4/§5: only a Promotion compatible with this plan, for this member, may
    // be applied — the same validation the staff editor runs. A Promotion
    // about a Product, or one for new members only when this member is not
    // one, is refused here rather than silently dropped.
    const selectionError = await validatePromotionSelection(gymId, planId, promotionIds, memberId);
    if (selectionError) return res.status(selectionError.status).json({ error: selectionError.error });
    if (promotionIds.length > 0) {
      const marks = promotionIds.map(() => '?').join(',');
      const { rows: targets } = await db.query<{ id: number }>(
        `SELECT id FROM promotions WHERE id IN (${marks}) AND gym_id = ? AND applies_to = ?`,
        [...promotionIds, gymId, PLAN_PROMOTION_TARGET],
      );
      if (targets.length !== promotionIds.length) {
        return res.status(400).json({ error: 'One or more promotions are not about a Membership Plan' });
      }
    }

    // #1184 stage 3: the same rule the staff paths run — a mandatory benefit
    // cannot be declined and an unknown Product cannot be injected.
    const declinedResult = await resolveDeclinedBenefits(gymId, planId, req.body?.declined_benefits);
    if (declinedResult.error !== undefined) return res.status(400).json({ error: declinedResult.error });

    // The Draft, written as `POST /user-memberships` writes one.
    const umId = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(
        `INSERT INTO user_memberships
         (member_id, gym_id, membership_plan_id, base_price, plan_price_id, starts_at, status,
          created_by_name, created_by_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'member')`,
        [memberId, gymId, planId, eff.base_price, eff.plan_price_id, startsAt, ASSIGNMENT_CREATION_STATUS, memberRows[0].name],
      );
      await recordStatusChange(tx, {
        gymId, userMembershipId: insertId, memberId,
        previousStatus: null, newStatus: ASSIGNMENT_CREATION_STATUS,
        source: 'customer', actorUserId: userId,
      });
      await tx.query(
        'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
        [gymId, insertId, memberId],
      );
      await snapshotAssignedPlan(tx, {
        gymId, userMembershipId: insertId, membershipPlanId: planId,
        membershipFeePrice: eff.plan_price_id != null ? eff.price : null,
        declinedBenefits: declinedResult.declined,
      });
      return Number(insertId);
    });

    // §5/§6: each Promotion is applied with its own immutable snapshot, after
    // the Draft exists — the staff assign path does the same.
    for (const promotionId of promotionIds) {
      await applyPromotionToMembership(gymId, userId, 'customer', umId, promotionId);
    }

    // Save & Pay (#1108 stage 2): the point of no return. A first cycle that
    // owes nothing — a free plan, or a Promotion waiving it — activates now.
    const fee = await currentMembershipFee(gymId, umId);
    const owesNothing = !(fee != null && fee > 0);
    const outcome = await db.transaction(async (tx) => owesNothing
      ? commitAssignment(tx, { gymId, userMembershipId: umId, fromStatuses: [ASSIGNMENT_CREATION_STATUS], confirm, source: 'customer', actorUserId: userId })
      : submitForPayment(tx, { gymId, userMembershipId: umId, confirm, source: 'customer', actorUserId: userId }));

    if (outcome.kind === 'conflict' || outcome.kind === 'pending_conflict' || outcome.kind === 'bad_date') {
      // The Draft stays — nobody's plan — and is discarded so the member can
      // try again from a clean state rather than accumulating Drafts.
      await db.query(
        `UPDATE user_memberships SET status = 'cancelled', closed_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ? AND status = ?`,
        [umId, gymId, ASSIGNMENT_CREATION_STATUS],
      );
      if (outcome.kind === 'conflict') {
        const { rows: planRows } = await db.query<{ name: string }>('SELECT name FROM membership_plans WHERE id = ?', [planId]);
        return res.status(409).json(activePlanConflictBody(outcome.conflicts, planRows[0]?.name ?? null));
      }
      if (outcome.kind === 'pending_conflict') {
        return res.status(409).json({ error: 'plan_pending_payment', message: 'You already have a membership awaiting payment.' });
      }
      return res.status(400).json({ error: outcome.message });
    }
    if (outcome.kind !== 'committed' && outcome.kind !== 'submitted') {
      return res.status(500).json({ error: 'Membership could not be saved' });
    }

    const { rows } = await db.query<any>(
      `SELECT um.id, um.status, um.starts_at, mp.name AS plan_name FROM user_memberships um
         LEFT JOIN membership_plans mp ON mp.id = um.membership_plan_id WHERE um.id = ?`,
      [umId],
    );
    recordAudit(req, {
      action: 'create', entityType: 'user_membership', entityId: umId,
      next: { ...rows[0], promotion_ids: promotionIds, membership_fee: fee },
    });
    res.status(201).json({ ...rows[0], membership_fee: fee, promotion_ids: promotionIds });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
