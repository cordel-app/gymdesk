import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { insertAndFetch } from '../infra/db-helpers';

export const promotionDetailsRouter = Router({ mergeParams: true });

async function verifyPromotion(gymId: string, promotionId: number) {
  const { rows } = await db.query('SELECT id FROM promotions WHERE id = ? AND gym_id = ?', [promotionId, gymId]);
  return rows.length > 0;
}

// #551: Membership Fee Benefits is a UI-level category, not a new table — it's
// the one promotion_period_benefits row whose charge_type is 'membership_fee',
// pulled into its own singleton endpoint so it can't be clobbered by the
// generic /period-benefits bulk-replace, and so the item can't be swapped out.
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

/* ---------- period benefits ---------- */

promotionDetailsRouter.get('/period-benefits', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  try {
    // Membership Fee is its own category (#551) — excluded here, served by
    // GET /membership-fee-benefit instead.
    const { rows } = await db.query(
      `SELECT ppb.*, ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM promotion_period_benefits ppb
       JOIN charge_types ct ON ct.id = ppb.charge_type_id
       WHERE ppb.promotion_id = ? AND ppb.gym_id = ? AND ct.code != 'membership_fee'
       ORDER BY ppb.id ASC`,
      [promotionId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

promotionDetailsRouter.put('/period-benefits', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

  for (const item of items) {
    const err = validatePeriodBenefit(item);
    if (err) return res.status(400).json({ error: err });
  }

  const membershipFeeId = await getMembershipFeeChargeTypeId();
  if (items.some((i: any) => parseInt(i.charge_type_id, 10) === membershipFeeId)) {
    return res.status(400).json({ error: 'Membership Fee benefits are managed via /membership-fee-benefit' });
  }

  try {
    await db.transaction(async (tx) => {
      // Never touches the Membership Fee row (#551) — that row lives in this
      // same table but is owned by the /membership-fee-benefit singleton.
      await tx.query(
        'DELETE FROM promotion_period_benefits WHERE promotion_id = ? AND gym_id = ? AND charge_type_id != ?',
        [promotionId, gymId, membershipFeeId],
      );
      for (const item of items) {
        const dur = item.duration_months != null ? parseInt(item.duration_months, 10) : null;
        const action = item.action ?? null;
        const value = periodBenefitValue(action, item.value);
        await tx.query(
          'INSERT INTO promotion_period_benefits (gym_id, promotion_id, charge_type_id, quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [gymId, promotionId, item.charge_type_id, parseInt(item.quantity, 10), parseInt(item.frequency_interval, 10), item.frequency_unit, dur ?? null, item.enabled != null ? (item.enabled ? 1 : 0) : 1, action, value],
        );
      }
    });
    const { rows } = await db.query(
      `SELECT ppb.*, ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM promotion_period_benefits ppb
       JOIN charge_types ct ON ct.id = ppb.charge_type_id
       WHERE ppb.promotion_id = ? AND ppb.gym_id = ? AND ct.code != 'membership_fee'
       ORDER BY ppb.id ASC`,
      [promotionId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Mirrors promotion_charge_benefits' action/value convention (#487 stage 1).
// Stage 1 is display/config only — these fields have no effect on real
// billing yet (that wiring is stage 2/3, a separate future PR).
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

promotionDetailsRouter.post('/period-benefits', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  const err = validatePeriodBenefit(req.body);
  if (err) return res.status(400).json({ error: err });
  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

  const membershipFeeId = await getMembershipFeeChargeTypeId();
  if (parseInt(req.body.charge_type_id, 10) === membershipFeeId) {
    return res.status(400).json({ error: 'Membership Fee benefits are managed via /membership-fee-benefit' });
  }

  const { charge_type_id, quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value } = req.body;
  try {
    const dur = duration_months != null ? parseInt(duration_months, 10) : null;
    const act = action ?? null;
    const val = periodBenefitValue(act, value);
    const row = await insertAndFetch(
      'INSERT INTO promotion_period_benefits (gym_id, promotion_id, charge_type_id, quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [gymId, promotionId, charge_type_id, parseInt(quantity, 10), parseInt(frequency_interval, 10), frequency_unit, dur ?? null, enabled != null ? (enabled ? 1 : 0) : 1, act, val],
      `SELECT ppb.*, ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM promotion_period_benefits ppb
       JOIN charge_types ct ON ct.id = ppb.charge_type_id
       WHERE ppb.id = ?`,
      (id) => [id],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

promotionDetailsRouter.put('/period-benefits/:pbId', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  const { pbId } = req.params;
  const err = validatePeriodBenefit(req.body);
  if (err) return res.status(400).json({ error: err });

  const membershipFeeId = await getMembershipFeeChargeTypeId();
  if (parseInt(req.body.charge_type_id, 10) === membershipFeeId) {
    return res.status(400).json({ error: 'Membership Fee benefits are managed via /membership-fee-benefit' });
  }
  const { rows: existingRows } = await db.query(
    'SELECT charge_type_id FROM promotion_period_benefits WHERE id = ? AND promotion_id = ? AND gym_id = ?',
    [pbId, promotionId, gymId],
  );
  if (existingRows.length === 0) return res.status(404).json({ error: 'Period benefit not found' });
  if (existingRows[0].charge_type_id === membershipFeeId) {
    return res.status(400).json({ error: 'Membership Fee benefits are managed via /membership-fee-benefit' });
  }

  const { charge_type_id, quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value } = req.body;
  try {
    const dur = duration_months != null ? parseInt(duration_months, 10) : null;
    const act = action ?? null;
    const val = periodBenefitValue(act, value);
    const { rowCount } = await db.query(
      `UPDATE promotion_period_benefits
         SET charge_type_id = ?, quantity = ?, frequency_interval = ?, frequency_unit = ?, duration_months = ?, enabled = ?, action = ?, value = ?
       WHERE id = ? AND promotion_id = ? AND gym_id = ?`,
      [charge_type_id, parseInt(quantity, 10), parseInt(frequency_interval, 10), frequency_unit,
       dur ?? null, enabled != null ? (enabled ? 1 : 0) : 1, act, val, pbId, promotionId, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Period benefit not found' });
    const { rows } = await db.query(
      `SELECT ppb.*, ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM promotion_period_benefits ppb
       JOIN charge_types ct ON ct.id = ppb.charge_type_id
       WHERE ppb.id = ?`,
      [pbId],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

promotionDetailsRouter.delete('/period-benefits/:pbId', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  try {
    const membershipFeeId = await getMembershipFeeChargeTypeId();
    const { rowCount } = await db.query(
      'DELETE FROM promotion_period_benefits WHERE id = ? AND promotion_id = ? AND gym_id = ? AND charge_type_id != ?',
      [req.params.pbId, promotionId, gymId, membershipFeeId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Period benefit not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});

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

/* ---------- included benefits ---------- */

promotionDetailsRouter.get('/included-benefits', async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  try {
    const { rows } = await db.query(
      `SELECT pib.*, ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM promotion_included_benefits pib
       JOIN charge_types ct ON ct.id = pib.charge_type_id
       WHERE pib.promotion_id = ? AND pib.gym_id = ?
       ORDER BY pib.id ASC`,
      [promotionId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

promotionDetailsRouter.put('/included-benefits', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items must be an array' });
  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

  for (const item of items) {
    if (!item.charge_type_id) return res.status(400).json({ error: 'charge_type_id is required' });
    const qty = parseInt(item.quantity, 10);
    if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: 'quantity must be a positive integer' });
  }

  if (items.length > 0) {
    const chargeTypeIds = items.map((i: any) => i.charge_type_id);
    const placeholders = chargeTypeIds.map(() => '?').join(',');
    const { rows: validTypes } = await db.query(
      `SELECT id FROM charge_types WHERE is_gym_charge = 0 AND id IN (${placeholders})`,
      chargeTypeIds,
    );
    if (validTypes.length !== chargeTypeIds.length) {
      return res.status(400).json({ error: 'One or more charge types are invalid or are gym charges' });
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM promotion_included_benefits WHERE promotion_id = ? AND gym_id = ?', [promotionId, gymId]);
      for (const item of items) {
        await tx.query(
          'INSERT INTO promotion_included_benefits (gym_id, promotion_id, charge_type_id, quantity) VALUES (?, ?, ?, ?)',
          [gymId, promotionId, item.charge_type_id, parseInt(item.quantity, 10)],
        );
      }
    });
    const { rows } = await db.query(
      `SELECT pib.*, ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM promotion_included_benefits pib
       JOIN charge_types ct ON ct.id = pib.charge_type_id
       WHERE pib.promotion_id = ? AND pib.gym_id = ?
       ORDER BY pib.id ASC`,
      [promotionId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});
