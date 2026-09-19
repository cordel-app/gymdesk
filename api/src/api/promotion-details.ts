import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import {
  benefitTableForCategory,
  classifySellableItem,
  SellableItemBenefitCategory,
} from '../domain/sellableItemClassification';

export const promotionDetailsRouter = Router({ mergeParams: true });

async function verifyPromotion(gymId: string, promotionId: number) {
  const { rows } = await db.query('SELECT id FROM promotions WHERE id = ? AND gym_id = ?', [promotionId, gymId]);
  return rows.length > 0;
}

// #551: Membership Fee Benefits is a UI-level category, not a new table — it's
// the one promotion_period_benefits row whose charge_type is 'membership_fee',
// pulled into its own singleton endpoint so the item can't be swapped out.
async function getMembershipFeeChargeTypeId(): Promise<number> {
  const { rows } = await db.query("SELECT id FROM charge_types WHERE code = 'membership_fee'");
  return rows[0].id;
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

/* ---------- charge benefits ---------- */

promotionDetailsRouter.get('/charge-benefits', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  const { rows } = await db.query(
    `SELECT pcb.*, COALESCE(gc.name, ct.name) AS gym_charge_name, ct.code AS gym_charge_code,
            gc.status AS gym_charge_status
     FROM promotion_charge_benefits pcb
     JOIN gym_charges gc ON gc.id = pcb.gym_charge_id
     LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
     WHERE pcb.promotion_id = ? AND pcb.gym_id = ?
     ORDER BY gym_charge_name ASC`,
    [promotionId, gymId],
  );
  res.json(rows);
});

promotionDetailsRouter.put('/charge-benefits', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

  const VALID_ACTIONS = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price'];
  for (const item of items) {
    if (item.action && !VALID_ACTIONS.includes(item.action)) {
      return res.status(400).json({ error: `Invalid action: ${item.action}` });
    }
  }

  const active = items.filter((i: any) => i.action && i.action !== 'no_benefit');

  if (active.length > 0) {
    const gymChargeIds = active.map((i: any) => i.gym_charge_id);
    const placeholders = gymChargeIds.map(() => '?').join(',');
    const { rows: owned } = await db.query(
      `SELECT id FROM gym_charges WHERE gym_id = ? AND status = 'active' AND deleted_at IS NULL AND id IN (${placeholders})`,
      [gymId, ...gymChargeIds],
    );
    if (owned.length !== gymChargeIds.length) {
      return res.status(404).json({ error: 'One or more gym charges not found or not available in this gym' });
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM promotion_charge_benefits WHERE promotion_id = ? AND gym_id = ?', [promotionId, gymId]);
      for (const item of active) {
        const needsValue = ['percentage_discount', 'fixed_discount', 'fixed_price'].includes(item.action);
        const value = needsValue && item.value != null && item.value !== '' ? parseFloat(item.value) : null;
        await tx.query(
          'INSERT INTO promotion_charge_benefits (gym_id, promotion_id, gym_charge_id, action, value) VALUES (?, ?, ?, ?, ?)',
          [gymId, promotionId, item.gym_charge_id, item.action, value],
        );
      }
    });
    const { rows } = await db.query(
      `SELECT pcb.*, COALESCE(gc.name, ct.name) AS gym_charge_name, ct.code AS gym_charge_code,
              gc.status AS gym_charge_status
       FROM promotion_charge_benefits pcb
       JOIN gym_charges gc ON gc.id = pcb.gym_charge_id
       LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
       WHERE pcb.promotion_id = ? AND pcb.gym_id = ?
       ORDER BY gym_charge_name ASC`,
      [promotionId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* ---------- membership fee benefit config helpers ---------- */
// Shared by the /membership-fee-benefit singleton below. The generic
// Period/Included Benefits CRUD that used to share these (keyed to the old
// `charge_types` pseudo-catalog) was retired in #550 stage 3 — replaced by
// the Sellable-Item-keyed /session-benefits, /oneoff-benefits and
// /periodical-benefits below.

// Mirrors promotion_charge_benefits' action/value convention (#487 stage 1).
const PERIOD_BENEFIT_ACTIONS = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price'];

function validatePeriodBenefit(body: any) {
  const { charge_type_id, quantity, frequency_interval, frequency_unit, duration_months, action, value } = body;
  if (!charge_type_id) return 'charge_type_id is required';
  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty <= 0) return 'quantity must be a positive integer';
  const freq = parseInt(frequency_interval, 10);
  if (isNaN(freq) || freq <= 0) return 'frequency_interval must be a positive integer';
  if (!['week', 'month'].includes(frequency_unit)) return "frequency_unit must be 'week' or 'month'";
  if (duration_months != null) {
    const dur = parseInt(duration_months, 10);
    if (isNaN(dur) || dur <= 0) return 'duration_months must be a positive integer';
  }
  if (action != null && !PERIOD_BENEFIT_ACTIONS.includes(action)) return `Invalid action: ${action}`;
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
function periodBenefitValue(action: any, value: any) {
  const needsValue = ['percentage_discount', 'fixed_discount', 'fixed_price'].includes(action);
  return needsValue && value != null && value !== '' ? parseFloat(value) : null;
}

/* ---------- membership fee benefit (singleton; #551) ---------- */
// Reuses the Period Benefits table/validation/action-value mechanism exactly
// (see validatePeriodBenefit/periodBenefitValue above, and computeFinalPrice's
// duration_months gate in membership-promotions.ts) — the only difference is
// that the item is always the 'membership_fee' charge type, server-resolved,
// never accepted from the client.

promotionDetailsRouter.get('/membership-fee-benefit', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  try {
    const membershipFeeId = await getMembershipFeeChargeTypeId();
    const { rows } = await db.query(
      `SELECT ppb.*, ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM promotion_period_benefits ppb
       JOIN charge_types ct ON ct.id = ppb.charge_type_id
       WHERE ppb.promotion_id = ? AND ppb.gym_id = ? AND ppb.charge_type_id = ?`,
      [promotionId, gymId, membershipFeeId],
    );
    res.json(rows[0] ?? null);
  } catch (err) { next(err); }
});

promotionDetailsRouter.put('/membership-fee-benefit', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

  const membershipFeeId = await getMembershipFeeChargeTypeId();
  const err = validatePeriodBenefit({ ...req.body, charge_type_id: membershipFeeId });
  if (err) return res.status(400).json({ error: err });

  const { quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value } = req.body;
  try {
    const dur = duration_months != null ? parseInt(duration_months, 10) : null;
    const act = action ?? null;
    const val = periodBenefitValue(act, value);
    await db.transaction(async (tx) => {
      const { rows: existing } = await tx.query(
        'SELECT id FROM promotion_period_benefits WHERE promotion_id = ? AND gym_id = ? AND charge_type_id = ?',
        [promotionId, gymId, membershipFeeId],
      );
      if (existing.length > 0) {
        await tx.query(
          `UPDATE promotion_period_benefits
             SET quantity = ?, frequency_interval = ?, frequency_unit = ?, duration_months = ?, enabled = ?, action = ?, value = ?
           WHERE id = ? AND promotion_id = ? AND gym_id = ?`,
          [parseInt(quantity, 10), parseInt(frequency_interval, 10), frequency_unit, dur ?? null,
           enabled != null ? (enabled ? 1 : 0) : 1, act, val, existing[0].id, promotionId, gymId],
        );
      } else {
        await tx.query(
          'INSERT INTO promotion_period_benefits (gym_id, promotion_id, charge_type_id, quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [gymId, promotionId, membershipFeeId, parseInt(quantity, 10), parseInt(frequency_interval, 10), frequency_unit, dur ?? null,
           enabled != null ? (enabled ? 1 : 0) : 1, act, val],
        );
      }
    });
    const { rows } = await db.query(
      `SELECT ppb.*, ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM promotion_period_benefits ppb
       JOIN charge_types ct ON ct.id = ppb.charge_type_id
       WHERE ppb.promotion_id = ? AND ppb.gym_id = ? AND ppb.charge_type_id = ?`,
      [promotionId, gymId, membershipFeeId],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ---------- session / one-off / periodical benefits (#550 stage 3) ---------- */
// Replaces the "quantity granted" half of the legacy Period/Included Benefits
// (one-time-grant shape, same as the old Included Benefits) with three tables
// keyed to a real Sellable Item (`gym_charges`, migration 155) instead of the
// old `charge_types` pseudo-catalog, split by `classifySellableItem()` into
// Session / One-off / Periodical. The legacy `/period-benefits` (excluding
// Membership Fee, #551) and `/included-benefits` endpoints have been retired
// (#550 stage 3) now that the admin frontend reads/writes these three
// instead — `promotion_period_benefits` and `promotion_included_benefits`
// stay in the schema (the former still backs `/membership-fee-benefit`
// below; the latter is now unused but its data isn't backfilled anywhere per
// the issue owner's explicit "start from scratch" instruction on #550).

function selectSellableItemBenefits(table: string): string {
  return `SELECT b.*, gc.name AS gym_charge_name, gc.type AS gym_charge_type,
                 gc.billing_frequency AS gym_charge_billing_frequency, gc.status AS gym_charge_status
          FROM ${table} b
          JOIN gym_charges gc ON gc.id = b.gym_charge_id
          WHERE b.promotion_id = ? AND b.gym_id = ?
          ORDER BY gym_charge_name ASC`;
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
      const { rows } = await db.query(selectSellableItemBenefits(table), [promotionId, gymId]);
      res.json(rows);
    } catch (err) { next(err); }
  });

  promotionDetailsRouter.put(`/${path}`, requireRole('admin'), async (req, res, next) => {
    const { gymId, gymMembershipId } = getTenantContext(req);
    const promotionId = parseInt((req.params as any).id, 10);
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
    if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

    const gymChargeIds: number[] = [];
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
      seen.add(gymChargeId);
      gymChargeIds.push(gymChargeId);
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
        await tx.query(`DELETE FROM ${table} WHERE promotion_id = ? AND gym_id = ?`, [promotionId, gymId]);
        for (const item of items) {
          await tx.query(
            `INSERT INTO ${table} (gym_id, promotion_id, gym_charge_id, quantity, created_by_membership_id) VALUES (?, ?, ?, ?, ?)`,
            [gymId, promotionId, parseInt(item.gym_charge_id, 10), parseInt(item.quantity, 10), gymMembershipId ?? null],
          );
        }
      });
      const { rows } = await db.query(selectSellableItemBenefits(table), [promotionId, gymId]);
      res.json(rows);
    } catch (err) { next(err); }
  });
}
