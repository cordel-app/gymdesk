import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import {
  benefitTableForCategory,
  classifySellableItem,
  SellableItemBenefitCategory,
} from '../domain/sellableItemClassification';
import { promotionDurationMonths } from '../domain/promotionBenefits';
import {
  NO_SELLABLE_ITEM_BENEFIT,
  SellableItemBenefit,
  parseSellableItemBenefitInput,
  shapeSellableItemBenefitRow,
  toSellableItemBenefit,
} from '../domain/sellableItemBenefitActions';
import {
  grossBenefitUnitPrice,
  withSellableItemBenefitPrices,
} from './sellable-item-benefit-pricing';
import { SellableItemFrequency } from '../domain/billingSimulation';
import {
  PromotionSimulationGrant,
  computePromotionBillingEventSimulation,
} from '../domain/promotionBillingEventSimulation';

export const promotionDetailsRouter = Router({ mergeParams: true });

async function verifyPromotion(gymId: string, promotionId: number) {
  const { rows } = await db.query('SELECT id FROM promotions WHERE id = ? AND gym_id = ?', [promotionId, gymId]);
  return rows.length > 0;
}

/* ---------- plan targeting ---------- */

promotionDetailsRouter.get('/plans', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  const { rows } = await db.query(
    `SELECT p.id, p.name FROM promotion_membership_plans pmp
     JOIN membership_plans p ON p.id = pmp.membership_plan_id
     WHERE pmp.promotion_id = ? AND pmp.gym_id = ?
     ORDER BY p.name ASC`,
    [promotionId, gymId],
  );
  res.json(rows);
});

// #554 ("Suitable Membership Plans"): every *newly added* plan id must be an
// active, non-deleted plan belonging to this gym — the frontend only ever
// offers active plans as new selectable options, so this is a server-side
// backstop, never trusted from the client alone. An id that was ALREADY
// associated with this promotion is allowed through even if the plan has
// since gone inactive: the promotion's own edit flow always resubmits the
// full current selection (see plansDraft in the admin page), and a plan
// being deactivated elsewhere must never silently break an unrelated save
// of this promotion or drop a pre-existing association (Historical
// Integrity in the ticket). Explicitly unchecking a plan — active or not —
// is still the only way to remove its association.
promotionDetailsRouter.put('/plans', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  const { membership_plan_ids } = req.body;
  if (!Array.isArray(membership_plan_ids)) return res.status(400).json({ error: 'membership_plan_ids must be an array' });

  const requestedIds: number[] = [];
  for (const raw of membership_plan_ids) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'membership_plan_ids must contain positive integers' });
    requestedIds.push(n);
  }
  // Duplicate associations are prevented by deduping the request itself
  // (the table also has a unique (promotion_id, membership_plan_id) index).
  const dedupedIds = Array.from(new Set(requestedIds));

  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

  const { rows: currentRows } = await db.query(
    'SELECT membership_plan_id FROM promotion_membership_plans WHERE promotion_id = ? AND gym_id = ?',
    [promotionId, gymId],
  );
  const currentIds = new Set<number>(currentRows.map((r: any) => r.membership_plan_id));
  const newIds = dedupedIds.filter((id) => !currentIds.has(id));

  if (newIds.length > 0) {
    const placeholders = newIds.map(() => '?').join(',');
    const { rows } = await db.query(
      `SELECT id FROM membership_plans
       WHERE gym_id = ? AND lifecycle_status = 'active' AND deleted_at IS NULL AND id IN (${placeholders})`,
      [gymId, ...newIds],
    );
    if (rows.length !== newIds.length) {
      return res.status(400).json({ error: 'One or more selected membership plans are invalid, inactive, or not found in this gym' });
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM promotion_membership_plans WHERE promotion_id = ? AND gym_id = ?', [promotionId, gymId]);
      for (const planId of dedupedIds) {
        await tx.query(
          'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
          [gymId, promotionId, planId],
        );
      }
    });
    res.json({ promotion_id: promotionId, membership_plan_ids: dedupedIds });
  } catch (err) { next(err); }
});

/* ---------- membership fee benefit (singleton; #551) ---------- */
// #635 stage 5: the Membership Fee Benefit has its own table —
// `promotion_membership_fee_benefits` (migration 179), one row per Promotion.
// It replaces both of the places the benefit used to live: the
// `promotion_period_benefits` row whose charge type was `membership_fee`
// (#551) and, for Promotions configured before #626 removed the Promotion
// Charge Benefits editor, a `promotion_charge_benefits` row on a Sellable
// Item of that charge type. Neither table exists any more, and there is no
// item to point at: "which item" was never a choice here, which is why the
// old endpoint resolved the charge type server-side and refused to take one
// from the client.
//
// `action`/`value` are what billing applies, for `duration_months` months
// counted from when the Promotion was applied (see the fee resolution in
// membership-promotions.ts). Those four fields are the whole benefit.
//
// #814 removed the three it used to carry beside them — `quantity`,
// `frequency_interval` and `frequency_unit` (migration 199). They were
// inherited from the Period Benefit shape the section was edited in ("2
// sessions every 3 months") and meant nothing here: there is one membership
// fee per assignment and its cadence is the assignment's own Billing frequency
// (`ASSIGNMENT_CADENCE`), never a Promotion's. Nothing priced on them. Do not
// reintroduce a recurrence on this benefit.

const MEMBERSHIP_FEE_ACTIONS = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price'];

function validateMembershipFeeBenefit(body: any) {
  const { duration_months, action, value } = body;
  if (duration_months != null) {
    const dur = parseInt(duration_months, 10);
    if (isNaN(dur) || dur <= 0) return 'duration_months must be a positive integer';
  }
  if (action != null && !MEMBERSHIP_FEE_ACTIONS.includes(action)) return `Invalid action: ${action}`;
  if (action === 'percentage_discount') {
    const v = value != null && value !== '' ? parseFloat(value) : NaN;
    if (isNaN(v) || v < 0 || v > 100) return 'value must be between 0 and 100 for percentage_discount';
  } else if (action === 'fixed_discount' || action === 'fixed_price') {
    const v = value != null && value !== '' ? parseFloat(value) : NaN;
    if (isNaN(v) || v < 0) return 'value must be a non-negative number';
  }
  return null;
}

// value is only persisted for actions that need one; no_benefit/waive/absent → null.
function membershipFeeValue(action: any, value: any) {
  const needsValue = ['percentage_discount', 'fixed_discount', 'fixed_price'].includes(action);
  return needsValue && value != null && value !== '' ? parseFloat(value) : null;
}

// An explicit projection rather than `SELECT *`, so the response shape is the
// API's contract and not whatever the table happens to hold: during the
// API-before-migration-199 deploy window the columns #814 retired are still
// there, and this is what keeps them out of the answer.
const SELECT_MEMBERSHIP_FEE_BENEFIT =
  `SELECT id, gym_id, promotion_id, duration_months, enabled, action, value, created_at
   FROM promotion_membership_fee_benefits WHERE promotion_id = ? AND gym_id = ?`;

promotionDetailsRouter.get('/membership-fee-benefit', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  try {
    const { rows } = await db.query(SELECT_MEMBERSHIP_FEE_BENEFIT, [promotionId, gymId]);
    res.json(rows[0] ?? null);
  } catch (err) { next(err); }
});

promotionDetailsRouter.put('/membership-fee-benefit', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  // #625: the Promotion's own duration (free + paid + bonus) is the ceiling for
  // the benefit's duration, so load it alongside the existence check rather
  // than via the id-only verifyPromotion helper.
  const { rows: promoRows } = await db.query(
    'SELECT free_months, paid_months, bonus_months FROM promotions WHERE id = ? AND gym_id = ?',
    [promotionId, gymId],
  );
  if (promoRows.length === 0) return res.status(404).json({ error: 'Promotion not found' });

  const err = validateMembershipFeeBenefit(req.body);
  if (err) return res.status(400).json({ error: err });

  // #625: a Membership Fee Benefit can never outlast the Promotion. Reject an
  // explicit duration greater than the total Promotion duration so an invalid
  // configuration is never persisted (the Promotion is the source of truth and
  // is never extended to accommodate the benefit). A null duration is allowed —
  // it is treated as "the whole Promotion" when the forecast/billing applies it.
  const promoDuration = promotionDurationMonths(
    promoRows[0].free_months, promoRows[0].paid_months, promoRows[0].bonus_months,
  );
  const rawDuration = req.body.duration_months;
  if (rawDuration != null && rawDuration !== '') {
    const dur = parseInt(rawDuration, 10);
    if (dur > promoDuration) {
      return res.status(400).json({
        error: `duration_months cannot exceed the promotion duration of ${promoDuration} month(s)`,
      });
    }
  }

  const { duration_months, enabled, action, value } = req.body;
  try {
    const dur = duration_months != null && duration_months !== '' ? parseInt(duration_months, 10) : null;
    const act = action ?? null;
    const val = membershipFeeValue(act, value);
    // One row per Promotion (unique key `pmfb_promotion_unique`), so the
    // singleton PUT is an upsert rather than a replace-all delete/insert.
    await db.query(
      `INSERT INTO promotion_membership_fee_benefits
         (gym_id, promotion_id, duration_months, enabled, action, value)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         duration_months = VALUES(duration_months),
         enabled = VALUES(enabled), action = VALUES(action), value = VALUES(value)`,
      [gymId, promotionId, dur, enabled != null ? (enabled ? 1 : 0) : 1, act, val],
    );
    const { rows } = await db.query(SELECT_MEMBERSHIP_FEE_BENEFIT, [promotionId, gymId]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ---------- session / one-off / periodical benefits (#550 stage 3) ---------- */
// Replaces the "quantity granted" half of the legacy Period/Included Benefits
// (one-time-grant shape, same as the old Included Benefits) with three tables
// keyed to a real Sellable Item (`gym_charges`, migration 155) instead of the
// old `charge_types` pseudo-catalog, split by `classifySellableItem()` into
// Session / One-off / Periodical. The legacy `/period-benefits` (excluding
// Membership Fee, #551) and `/included-benefits` endpoints were retired in
// #550 stage 3 once the admin frontend read/wrote these three instead, and
// #635 stage 5 (migration 179) dropped the tables behind them —
// `promotion_period_benefits` and `promotion_included_benefits` — along with
// `promotion_charge_benefits`. Their data was not carried over, per the issue
// owner's explicit "start from scratch" instruction on #550 and the "clean up
// completely these legacy structure" answer on #635; the one exception is the
// Membership Fee Benefit, migrated into its own table above.

function selectSellableItemBenefits(table: string): string {
  // #920: the price columns come from the benefit row's own join rather than
  // the active catalogue, since a Promotion may still carry (and still grant) an
  // item that has since been deactivated — the same reason #915 joins them on
  // the Plan side.
  return `SELECT b.*, gc.name AS gym_charge_name, gc.type AS gym_charge_type,
                 gc.billing_frequency AS gym_charge_billing_frequency, gc.status AS gym_charge_status,
                 gc.amount AS gym_charge_amount, gc.tax_behavior AS gym_charge_tax_behavior,
                 tr.rate_percent AS gym_charge_tax_rate_percent
          FROM ${table} b
          JOIN gym_charges gc ON gc.id = b.gym_charge_id
          LEFT JOIN tax_rates tr ON tr.id = gc.tax_rate_id
          WHERE b.promotion_id = ? AND b.gym_id = ?
          ORDER BY gym_charge_name ASC`;
}

/**
 * One stored benefit row as the section's read selects it: the relationship's
 * own columns plus the Sellable Item's name, classification and — since #920 —
 * the three price columns the VAT-inclusive gross-up needs.
 */
interface PromotionBenefitRow {
  gym_charge_id: number;
  quantity: number;
  action: string | null;
  value: string | number | null;
  gym_charge_name: string;
  gym_charge_type: string;
  gym_charge_billing_frequency: string | null;
  gym_charge_status: string;
  gym_charge_amount: string | null;
  gym_charge_tax_behavior: string | null;
  gym_charge_tax_rate_percent: string | null;
}

/**
 * One section, as the API serves it. #896 stage 2: every read reports the
 * `(action, value)` pair normalized — `value` a number rather than mysql2's
 * `DECIMAL` string, and an action outside what a Promotion may configure read
 * back as the neutral default.
 *
 * #920 adds the Regular / Final Price pair beside it, VAT included, computed by
 * the one module the Membership Plan sections use (`withSellableItemBenefitPrices`,
 * over `applyLineBenefit()`): the ticket's requirement is that the Promotion UI
 * introduce no pricing logic of its own, so the amounts a Promotion section
 * quotes and the amounts the billing engine applies come from the same place.
 * Nothing is stored — they are computed on every read.
 */
async function loadPromotionBenefits(table: string, promotionId: unknown, gymId: string) {
  const { rows } = await db.query<PromotionBenefitRow>(
    selectSellableItemBenefits(table), [promotionId, gymId],
  );
  return withSellableItemBenefitPrices(
    'promotion',
    rows.map((row) => shapeSellableItemBenefitRow('promotion', row)),
  );
}

const CATEGORY_BENEFIT_ROUTES: { path: string; category: SellableItemBenefitCategory }[] = [
  { path: 'session-benefits', category: 'session' },
  { path: 'oneoff-benefits', category: 'oneoff' },
  { path: 'periodical-benefits', category: 'periodical' },
];

for (const { path, category } of CATEGORY_BENEFIT_ROUTES) {
  const table = benefitTableForCategory(category);

  promotionDetailsRouter.get(`/${path}`, async (req, res, next) => {
    const { gymId } = getTenantContext(req);
    const promotionId = (req.params as any).id;
    try {
      res.json(await loadPromotionBenefits(table, promotionId, gymId));
    } catch (err) { next(err); }
  });

  promotionDetailsRouter.put(`/${path}`, requireRole('admin'), async (req, res, next) => {
    const { gymId, gymMembershipId } = getTenantContext(req);
    const promotionId = parseInt((req.params as any).id, 10);
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
    if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

    const gymChargeIds: number[] = [];
    const submitted: { gym_charge_id: number; quantity: number; benefit: SellableItemBenefit | null }[] = [];
    const seen = new Set<number>();
    for (const item of items) {
      const gymChargeId = parseInt(item.gym_charge_id, 10);
      const quantity = parseInt(item.quantity, 10);
      if (!Number.isInteger(gymChargeId) || gymChargeId <= 0) {
        return res.status(400).json({ error: 'gym_charge_id is required' });
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'quantity must be a positive integer' });
      }
      if (seen.has(gymChargeId)) {
        return res.status(400).json({ error: `Duplicate gym_charge_id: ${gymChargeId}` });
      }
      // #896 stage 2 §6 — the line's own pricing treatment. A Promotion may
      // configure all five actions; the CHECK beside the table is the backstop,
      // this is the 400.
      const parsed = parseSellableItemBenefitInput('promotion', item);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      seen.add(gymChargeId);
      gymChargeIds.push(gymChargeId);
      submitted.push({ gym_charge_id: gymChargeId, quantity, benefit: parsed.benefit });
    }

    if (gymChargeIds.length > 0) {
      // Only *newly* selected items must be active — an item already
      // associated with this promotion stays selectable even if it has since
      // gone inactive elsewhere, so existing selections remain visible/
      // editable rather than silently 400ing the whole save (#550: "Existing
      // selected items must remain visible when editing a promotion, even if
      // they are now inactive"). Mirrors the Suitable Membership Plans PUT
      // pattern above (`/plans`).
      const { rows: existingAssoc } = await db.query(
        `SELECT gym_charge_id FROM ${table} WHERE promotion_id = ? AND gym_id = ?`,
        [promotionId, gymId],
      );
      const existingIds = new Set<number>(existingAssoc.map((r: any) => r.gym_charge_id));

      const placeholders = gymChargeIds.map(() => '?').join(',');
      const { rows: sellableItems } = await db.query(
        `SELECT id, type, billing_frequency, status FROM gym_charges
         WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
        [gymId, ...gymChargeIds],
      );
      if (sellableItems.length !== gymChargeIds.length) {
        return res.status(400).json({ error: 'One or more Sellable Items not found in this gym' });
      }
      const newlyInactive = sellableItems.find((si: any) => si.status !== 'active' && !existingIds.has(si.id));
      if (newlyInactive) {
        return res.status(400).json({ error: `Sellable Item ${newlyInactive.id} is not active in this gym` });
      }
      const mismatched = sellableItems.find((si: any) => classifySellableItem(si) !== category);
      if (mismatched) {
        return res.status(400).json({ error: `Sellable Item ${mismatched.id} does not belong in the '${category}' category` });
      }
    }

    try {
      await db.transaction(async (tx) => {
        // #896 stage 2: this is a replace-all, so a line the request configured
        // no treatment for has to keep the one it is stored with — read under
        // the same transaction that is about to delete it. Promotion rows that
        // predate migration 203 read `waive`, which is what they have always
        // meant; rewriting them to the neutral default here would, at stage 3,
        // start charging for an item the Promotion gives away.
        const { rows: stored } = await tx.query(
          `SELECT gym_charge_id, \`action\`, \`value\` FROM ${table}
            WHERE promotion_id = ? AND gym_id = ? FOR UPDATE`,
          [promotionId, gymId],
        );
        const kept = new Map<number, SellableItemBenefit>(
          stored.map((r: any) => [Number(r.gym_charge_id), shapeSellableItemBenefitRow('promotion', r)]),
        );
        await tx.query(`DELETE FROM ${table} WHERE promotion_id = ? AND gym_id = ?`, [promotionId, gymId]);
        for (const item of submitted) {
          const benefit = item.benefit ?? kept.get(item.gym_charge_id) ?? NO_SELLABLE_ITEM_BENEFIT;
          await tx.query(
            `INSERT INTO ${table}
               (gym_id, promotion_id, gym_charge_id, quantity, \`action\`, \`value\`, created_by_membership_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [gymId, promotionId, item.gym_charge_id, item.quantity,
             benefit.action, benefit.value, gymMembershipId ?? null],
          );
        }
      });
      res.json(await loadPromotionBenefits(table, promotionId, gymId));
    } catch (err) { next(err); }
  });
}

/* ---------- Billing Event Simulation (#922) ---------- */

/**
 * The billing events this Promotion affects, grouped by the date each falls on —
 * the Promotion card's counterpart to the Membership Plan's own Billing Event
 * Simulation (#915), computed by the same projection over the same billing
 * engine (`domain/promotionBillingEventSimulation.ts`).
 *
 * A read, always: nothing is persisted, nothing is charged, and no Promotion is
 * applied to anybody. It is a route of its own rather than a field on the
 * Promotion row because the Promotion list is a list — the card loads its
 * sub-resources when it expands, exactly as it loads the three Benefit sections
 * beside it.
 *
 * The amounts are VAT-inclusive, grossed up once by `grossBenefitUnitPrice()` —
 * the same gross-up the Benefit sections' own Regular / Final Price pair uses
 * (#919/#920), so the two halves of one card cannot quote an item two ways, and
 * no tax arithmetic reaches the page (#817).
 */
promotionDetailsRouter.get('/billing-event-simulation', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  try {
    const { rows: promos } = await db.query(
      `SELECT name, starts_at, free_months, paid_months, pay_beforehand_months, bonus_months
       FROM promotions WHERE id = ? AND gym_id = ?`,
      [promotionId, gymId],
    );
    if (promos.length === 0) return res.status(404).json({ error: 'Promotion not found' });
    const promo = promos[0] as {
      name: string | null;
      starts_at: string | Date | null;
      free_months: number | null;
      paid_months: number | null;
      pay_beforehand_months: number | null;
      bonus_months: number | null;
    };

    const grants: PromotionSimulationGrant[] = [];
    for (const { category } of CATEGORY_BENEFIT_ROUTES) {
      const { rows } = await db.query<PromotionBenefitRow>(
        selectSellableItemBenefits(benefitTableForCategory(category)), [promotionId, gymId],
      );
      for (const row of rows) {
        const gross = grossBenefitUnitPrice(row);
        // An item carrying no price at all bills nothing — which is not €0.00,
        // and is the same answer the Plan's own simulation gives (#915).
        if (gross == null) continue;
        grants.push({
          gymChargeId: Number(row.gym_charge_id),
          name: row.gym_charge_name,
          // The section the row is stored in, never a re-classification: #550's
          // `classifySellableItem()` is what put it there.
          category,
          billingFrequency: (row.gym_charge_billing_frequency as SellableItemFrequency | null) ?? null,
          unitPriceInclTax: gross,
          quantity: Number(row.quantity) || 1,
          benefit: toSellableItemBenefit('promotion', row.action, row.value),
        });
      }
    }

    res.json(computePromotionBillingEventSimulation({
      promotionName: promo.name,
      startsAt: promo.starts_at == null
        ? null
        : (promo.starts_at instanceof Date
          ? promo.starts_at.toISOString().slice(0, 10)
          : String(promo.starts_at).slice(0, 10)),
      freeMonths: promo.free_months,
      paidMonths: promo.paid_months,
      payBeforehandMonths: promo.pay_beforehand_months,
      bonusMonths: promo.bonus_months,
      grants,
    }));
  } catch (err) { next(err); }
});
