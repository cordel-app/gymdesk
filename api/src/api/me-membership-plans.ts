import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import { recordAudit } from '../infra/audit';
import { resolveMemberId } from './me';
import { computePriceFields } from './products';
import { selectPlanTaxRates } from '../domain/planTaxRate';
import {
  effectivePrice, planAssignabilityError,
} from './user-memberships';
import { resolveDeclinedBenefits, loadNamedPlanBenefitLines } from './declined-plan-benefits';
import { applyPromotionToProductSet, validatePromotionSelection } from './membership-promotions';
import { addCoverage, createDraft, submitForPayment as submitSetForPayment } from './product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from './product-set-configuration';
import { createProductSetCheckout, initialCharge } from './product-set-checkout';
import { PENDING_PAYMENT_STATUS } from './assignment-commit';
import { LIVE_ASSIGNMENT_STATUSES } from '../domain/oneActivePlan';
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

    const benefitsByPlan = await loadNamedPlanBenefitLines(gymId, plans.map((p) => Number(p.id)));
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
        benefits: benefitsByPlan.get(Number(plan.id)) ?? [],
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
  try {
    const memberId = await resolveMemberId(gymId, ctx);
    const { rows: memberRows } = await db.query<{ name: string }>(
      'SELECT name FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL', [memberId, gymId],
    );
    if (!memberRows[0]) return res.status(404).json({ error: 'Member profile not found' });

    // #1288 §28: a member never replaces a plan from the Members App — the
    // change is the gym's, through the Admin workflows. Enforced here, not by
    // hiding the button; `confirm` is no longer read at all. A plan already
    // awaiting payment blocks a second one for the same reason.
    const statusMarks = [...LIVE_ASSIGNMENT_STATUSES, PENDING_PAYMENT_STATUS].map(() => '?').join(',');
    const { rows: held } = await db.query<{ status: string }>(
      `SELECT um.status FROM user_memberships um
        WHERE um.gym_id = ? AND um.status IN (${statusMarks})
          AND (um.member_id = ? OR EXISTS (SELECT 1 FROM user_membership_members umm
                                            WHERE umm.user_membership_id = um.id AND umm.gym_id = um.gym_id AND umm.member_id = ?))
        ORDER BY FIELD(um.status, ?) DESC LIMIT 1`,
      [gymId, ...LIVE_ASSIGNMENT_STATUSES, PENDING_PAYMENT_STATUS, memberId, memberId, PENDING_PAYMENT_STATUS],
    );
    const { rows: inFlight } = await db.query<{ id: number }>(
      `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status IN ('draft','pending_payment')
        AND NOT (status = 'draft' AND last_activity_at < UTC_TIMESTAMP() - INTERVAL 120 MINUTE) LIMIT 1`,
      [gymId, memberId],
    );
    if (inFlight[0]) {
      return res.status(409).json({ error: 'plan_pending_payment', message: 'You already have a membership awaiting payment.' });
    }
    if (held[0]) {
      return held[0].status === PENDING_PAYMENT_STATUS
        ? res.status(409).json({ error: 'plan_pending_payment', message: 'You already have a membership awaiting payment.' })
        : res.status(409).json({ error: 'plan_change_via_gym', message: 'To change your plan, please contact your gym.' });
    }

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

    // #1325 PR 3a: the member's plan is a ProductSet version, not an assignment
    // Draft. The Draft is created with its frozen plan, its declined benefits and
    // each applied Promotion (its own snapshot, §16) in one transaction, and then
    // either activated at once — a first cycle that owes nothing — or saved for
    // payment with its initial event and checkout. The operational assignment the
    // member's screens read is projected at activation (`product-set-projection`).
    const actor = { name: memberRows[0].name, type: 'member' };
    const today = new Date().toISOString().slice(0, 10);
    const created = await db.transaction(async (tx) => {
      const draft = await createDraft(tx, {
        gymId, ownerMemberId: memberId, membershipPlanId: planId, startsAt, actor,
      });
      if (draft.kind !== 'created') return draft;
      await snapshotProductSetFromPlan(tx, {
        gymId, productSetId: draft.productSet.id, membershipPlanId: planId,
        membershipFeePrice: eff.plan_price_id != null ? eff.price : null,
        startsAt, declinedBenefits: declinedResult.declined,
      });
      await addCoverage(tx, {
        gymId, rootProductSetId: Number(draft.productSet.root_product_set_id), memberId, isOwner: true,
      });
      for (const promotionId of promotionIds) {
        await applyPromotionToProductSet(tx, gymId, userId, draft.productSet.id, promotionId);
      }
      return draft;
    });
    if (created.kind === 'in_flight') {
      return res.status(409).json({ error: 'plan_pending_payment', message: 'You already have a membership awaiting payment.' });
    }
    const setId = created.productSet.id;

    // Save & Pay: the point of no return. A first cycle that owes nothing — a
    // free plan, or a Promotion waiving it — activates now.
    const charge = await initialCharge(gymId, setId, startsAt);
    const owesNothing = !(charge != null && charge.amount > 0);
    let checkout: { paymentRequestId: number; checkoutUrl: string; billingEventId: number } | null = null;
    let status = 'active';
    if (owesNothing) {
      const out = await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: setId, today }));
      if (out.kind !== 'ok') return res.status(500).json({ error: 'Membership could not be saved' });
    } else {
      const moved = await db.transaction((tx) => submitSetForPayment(tx, gymId, setId));
      if (moved.kind !== 'ok') return res.status(500).json({ error: 'Membership could not be saved' });
      status = 'pending_payment';
      const { rows: emailRows } = await db.query<{ email: string | null }>(
        'SELECT email FROM members WHERE id = ? AND gym_id = ?', [memberId, gymId],
      );
      checkout = await createProductSetCheckout({
        gymId, productSetId: setId, memberId, memberEmail: emailRows[0]?.email ?? '',
        startsAt, charge: charge as NonNullable<typeof charge>,
      });
    }

    const { rows: planNameRows } = await db.query<{ name: string }>(
      'SELECT name FROM membership_plans WHERE id = ?', [planId]);
    const body = {
      id: setId, status, starts_at: startsAt, plan_name: planNameRows[0]?.name ?? null,
    };
    recordAudit(req, {
      action: 'create', entityType: 'product_set', entityId: setId,
      next: { ...body, promotion_ids: promotionIds, membership_fee: charge?.amount ?? 0 },
    });
    res.status(201).json({
      ...body, membership_fee: charge?.amount ?? 0, promotion_ids: promotionIds,
      checkout_url: checkout?.checkoutUrl ?? null,
      payment_request_id: checkout?.paymentRequestId ?? null,
      billing_event_id: checkout?.billingEventId ?? null,
    });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});
