import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import {
  benefitTableForCategory,
  classifyProduct,
  ProductBenefitCategory,
} from '../domain/productClassification';
import { promotionDurationMonths } from '../domain/promotionBenefits';
import {
  NO_PRODUCT_BENEFIT,
  ProductBenefit,
  parseProductBenefitInput,
  shapeProductBenefitRow,
  toProductBenefit,
} from '../domain/productBenefitActions';
import {
  DEFAULT_PROMOTION_ITEM_REQUIREMENT,
  PromotionItemRequirement,
  parsePromotionItemRequirementInput,
  toPromotionItemRequirement,
} from '../domain/promotionItemRequirement';
import {
  grossBenefitUnitPrice,
  withProductBenefitPrices,
} from './product-benefit-pricing';
import { ProductFrequency } from '../domain/billingSimulation';
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
// Charge Benefits editor, a `promotion_charge_benefits` row on a Product
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
// keyed to a real Product (`products`, migration 155) instead of the
// old `charge_types` pseudo-catalog, split by `classifyProduct()` into
// Session / One-off / Periodical. The legacy `/period-benefits` (excluding
// Membership Fee, #551) and `/included-benefits` endpoints were retired in
// #550 stage 3 once the admin frontend read/wrote these three instead, and
// #635 stage 5 (migration 179) dropped the tables behind them —
// `promotion_period_benefits` and `promotion_included_benefits` — along with
// `promotion_charge_benefits`. Their data was not carried over, per the issue
// owner's explicit "start from scratch" instruction on #550 and the "clean up
// completely these legacy structure" answer on #635; the one exception is the
// Membership Fee Benefit, migrated into its own table above.

function selectProductBenefits(table: string): string {
  // #920: the price columns come from the benefit row's own join rather than
  // the active catalogue, since a Promotion may still carry (and still grant) an
  // item that has since been deactivated — the same reason #915 joins them on
  // the Plan side.
  return `SELECT b.*, gc.name AS product_name, gc.type AS product_type,
                 gc.billing_frequency AS product_billing_frequency, gc.status AS product_status,
                 gc.amount AS product_amount, gc.tax_behavior AS product_tax_behavior,
                 tr.rate_percent AS product_tax_rate_percent
          FROM ${table} b
          JOIN products gc ON gc.id = b.product_id
          LEFT JOIN tax_rates tr ON tr.id = gc.tax_rate_id
          WHERE b.promotion_id = ? AND b.gym_id = ?
          ORDER BY product_name ASC`;
}

/**
 * One stored benefit row as the section's read selects it: the relationship's
 * own columns plus the Product's name, classification and — since #920 —
 * the three price columns the VAT-inclusive gross-up needs.
 */
interface PromotionBenefitRow {
  product_id: number;
  quantity: number;
  action: string | null;
  value: string | number | null;
  /** #959 — whether the member may decline this item when the Promotion is assigned. */
  requirement: string | null;
  product_name: string;
  product_type: string;
  product_billing_frequency: string | null;
  product_status: string;
  product_amount: string | null;
  product_tax_behavior: string | null;
  product_tax_rate_percent: string | null;
}

/**
 * One section, as the API serves it. #896 stage 2: every read reports the
 * `(action, value)` pair normalized — `value` a number rather than mysql2's
 * `DECIMAL` string, and an action outside what a Promotion may configure read
 * back as the neutral default.
 *
 * #920 adds the Regular / Final Price pair beside it, VAT included, computed by
 * the one module the Membership Plan sections use (`withProductBenefitPrices`,
 * over `applyLineBenefit()`): the ticket's requirement is that the Promotion UI
 * introduce no pricing logic of its own, so the amounts a Promotion section
 * quotes and the amounts the billing engine applies come from the same place.
 * Nothing is stored — they are computed on every read.
 */
async function loadPromotionBenefits(table: string, promotionId: unknown, gymId: string) {
  const { rows } = await db.query<PromotionBenefitRow>(
    selectProductBenefits(table), [promotionId, gymId],
  );
  return withProductBenefitPrices(
    'promotion',
    // #959: `b.*` brings the column along raw; normalize it so the wire shape is
    // always one of the two accepted values, the way the pair beside it is
    // normalized rather than echoed.
    rows.map((row) => ({
      ...shapeProductBenefitRow('promotion', row),
      requirement: toPromotionItemRequirement(row.requirement),
    })),
  );
}

const CATEGORY_BENEFIT_ROUTES: { path: string; category: ProductBenefitCategory }[] = [
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

    const productIds: number[] = [];
    const submitted: {
      product_id: number;
      quantity: number;
      benefit: ProductBenefit | null;
      /** #959: absent means the request named none, which is *keep what is stored*. */
      requirement?: PromotionItemRequirement;
    }[] = [];
    const seen = new Set<number>();
    for (const item of items) {
      const productId = parseInt(item.product_id, 10);
      const quantity = parseInt(item.quantity, 10);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'product_id is required' });
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'quantity must be a positive integer' });
      }
      if (seen.has(productId)) {
        return res.status(400).json({ error: `Duplicate product_id: ${productId}` });
      }
      // #896 stage 2 §6 — the line's own pricing treatment. A Promotion may
      // configure all five actions; the CHECK beside the table is the backstop,
      // this is the 400.
      const parsed = parseProductBenefitInput('promotion', item);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      // #959 — whether the member may decline this item when the Promotion is
      // assigned. An unknown value is a 400, never coerced: `optional` and
      // `mandatory` are opposite promises, so a typo must not silently become
      // either one. The CHECK beside the table is the backstop.
      const requirement = parsePromotionItemRequirementInput(item);
      if (requirement.error) return res.status(400).json({ error: requirement.error });
      seen.add(productId);
      productIds.push(productId);
      submitted.push({
        product_id: productId, quantity, benefit: parsed.benefit,
        ...(requirement.keep ? {} : { requirement: requirement.requirement }),
      });
    }

    if (productIds.length > 0) {
      // Only *newly* selected items must be active — an item already
      // associated with this promotion stays selectable even if it has since
      // gone inactive elsewhere, so existing selections remain visible/
      // editable rather than silently 400ing the whole save (#550: "Existing
      // selected items must remain visible when editing a promotion, even if
      // they are now inactive"). Mirrors the Suitable Membership Plans PUT
      // pattern above (`/plans`).
      const { rows: existingAssoc } = await db.query(
        `SELECT product_id FROM ${table} WHERE promotion_id = ? AND gym_id = ?`,
        [promotionId, gymId],
      );
      const existingIds = new Set<number>(existingAssoc.map((r: any) => r.product_id));

      const placeholders = productIds.map(() => '?').join(',');
      const { rows: products } = await db.query(
        `SELECT id, type, billing_frequency, status FROM products
         WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
        [gymId, ...productIds],
      );
      if (products.length !== productIds.length) {
        return res.status(400).json({ error: 'One or more Products not found in this gym' });
      }
      const newlyInactive = products.find((si: any) => si.status !== 'active' && !existingIds.has(si.id));
      if (newlyInactive) {
        return res.status(400).json({ error: `Product ${newlyInactive.id} is not active in this gym` });
      }
      const mismatched = products.find((si: any) => classifyProduct(si) !== category);
      if (mismatched) {
        return res.status(400).json({ error: `Product ${mismatched.id} does not belong in the '${category}' category` });
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
          `SELECT product_id, \`action\`, \`value\`, requirement FROM ${table}
            WHERE promotion_id = ? AND gym_id = ? FOR UPDATE`,
          [promotionId, gymId],
        );
        const kept = new Map<number, ProductBenefit>(
          stored.map((r: any) => [Number(r.product_id), shapeProductBenefitRow('promotion', r)]),
        );
        // #959: and the Requirement it is stored with, for the same replace-all
        // reason — a quantity-only save must not reset an item the gym made
        // optional back to mandatory.
        const keptRequirement = new Map<number, PromotionItemRequirement>(
          stored.map((r: any) => [
            Number(r.product_id), toPromotionItemRequirement(r.requirement),
          ]),
        );
        await tx.query(`DELETE FROM ${table} WHERE promotion_id = ? AND gym_id = ?`, [promotionId, gymId]);
        for (const item of submitted) {
          const benefit = item.benefit ?? kept.get(item.product_id) ?? NO_PRODUCT_BENEFIT;
          const requirement = item.requirement
            ?? keptRequirement.get(item.product_id)
            ?? DEFAULT_PROMOTION_ITEM_REQUIREMENT;
          await tx.query(
            `INSERT INTO ${table}
               (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`,
                requirement, created_by_membership_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [gymId, promotionId, item.product_id, item.quantity,
             benefit.action, benefit.value, requirement, gymMembershipId ?? null],
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
        selectProductBenefits(benefitTableForCategory(category)), [promotionId, gymId],
      );
      for (const row of rows) {
        const gross = grossBenefitUnitPrice(row);
        // An item carrying no price at all bills nothing — which is not €0.00,
        // and is the same answer the Plan's own simulation gives (#915).
        if (gross == null) continue;
        grants.push({
          productId: Number(row.product_id),
          name: row.product_name,
          // The section the row is stored in, never a re-classification: #550's
          // `classifyProduct()` is what put it there.
          category,
          billingFrequency: (row.product_billing_frequency as ProductFrequency | null) ?? null,
          unitPriceInclTax: gross,
          quantity: Number(row.quantity) || 1,
          benefit: toProductBenefit('promotion', row.action, row.value),
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
