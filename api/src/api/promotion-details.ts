import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { insertAndFetch } from '../infra/db-helpers';

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

promotionDetailsRouter.put('/plans', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  const { membership_plan_ids } = req.body;
  if (!Array.isArray(membership_plan_ids)) return res.status(400).json({ error: 'membership_plan_ids must be an array' });
  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

  if (membership_plan_ids.length > 0) {
    const placeholders = membership_plan_ids.map(() => '?').join(',');
    const { rows } = await db.query(
      `SELECT id FROM membership_plans WHERE gym_id = ? AND id IN (${placeholders})`,
      [gymId, ...membership_plan_ids],
    );
    if (rows.length !== membership_plan_ids.length) {
      return res.status(404).json({ error: 'One or more plans not found in this gym' });
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM promotion_membership_plans WHERE promotion_id = ? AND gym_id = ?', [promotionId, gymId]);
      for (const planId of membership_plan_ids) {
        await tx.query(
          'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
          [gymId, promotionId, planId],
        );
      }
    });
    res.json({ promotion_id: promotionId, membership_plan_ids });
  } catch (err) { next(err); }
});

/* ---------- charge benefits ---------- */

promotionDetailsRouter.get('/charge-benefits', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  const { rows } = await db.query(
    `SELECT pcb.*, ct.name AS gym_charge_name, ct.code AS gym_charge_code,
            gc.availability AS gym_charge_availability
     FROM promotion_charge_benefits pcb
     JOIN gym_charges gc ON gc.id = pcb.gym_charge_id
     JOIN charge_types ct ON ct.id = gc.charge_type_id
     WHERE pcb.promotion_id = ? AND pcb.gym_id = ?
     ORDER BY ct.name ASC`,
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

  const active = items.filter((i: any) => i.action && i.action !== 'no_benefit');

  if (active.length > 0) {
    const gymChargeIds = active.map((i: any) => i.gym_charge_id);
    const placeholders = gymChargeIds.map(() => '?').join(',');
    const { rows: owned } = await db.query(
      `SELECT id FROM gym_charges WHERE gym_id = ? AND availability = 'available' AND id IN (${placeholders})`,
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
        const value = item.value != null && item.value !== '' ? parseFloat(item.value) : null;
        await tx.query(
          'INSERT INTO promotion_charge_benefits (gym_id, promotion_id, gym_charge_id, action, value) VALUES (?, ?, ?, ?, ?)',
          [gymId, promotionId, item.gym_charge_id, item.action, value],
        );
      }
    });
    const { rows } = await db.query(
      `SELECT pcb.*, ct.name AS gym_charge_name, ct.code AS gym_charge_code,
              gc.availability AS gym_charge_availability
       FROM promotion_charge_benefits pcb
       JOIN gym_charges gc ON gc.id = pcb.gym_charge_id
       JOIN charge_types ct ON ct.id = gc.charge_type_id
       WHERE pcb.promotion_id = ? AND pcb.gym_id = ?
       ORDER BY ct.name ASC`,
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
    const { rows } = await db.query(
      `SELECT ppb.*, ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM promotion_period_benefits ppb
       JOIN charge_types ct ON ct.id = ppb.charge_type_id
       WHERE ppb.promotion_id = ? AND ppb.gym_id = ?
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

  try {
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM promotion_period_benefits WHERE promotion_id = ? AND gym_id = ?', [promotionId, gymId]);
      for (const item of items) {
        await tx.query(
          'INSERT INTO promotion_period_benefits (gym_id, promotion_id, charge_type_id, quantity, frequency_interval, frequency_unit, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [gymId, promotionId, item.charge_type_id, parseInt(item.quantity, 10), parseInt(item.frequency_interval, 10), item.frequency_unit, item.enabled != null ? (item.enabled ? 1 : 0) : 1],
        );
      }
    });
    const { rows } = await db.query(
      `SELECT ppb.*, ct.code AS charge_type_code, ct.name AS charge_type_name
       FROM promotion_period_benefits ppb
       JOIN charge_types ct ON ct.id = ppb.charge_type_id
       WHERE ppb.promotion_id = ? AND ppb.gym_id = ?
       ORDER BY ppb.id ASC`,
      [promotionId, gymId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

function validatePeriodBenefit(body: any) {
  const { charge_type_id, quantity, frequency_interval, frequency_unit } = body;
  if (!charge_type_id) return 'charge_type_id is required';
  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty <= 0) return 'quantity must be a positive integer';
  const freq = parseInt(frequency_interval, 10);
  if (isNaN(freq) || freq <= 0) return 'frequency_interval must be a positive integer';
  if (!['week', 'month'].includes(frequency_unit)) return "frequency_unit must be 'week' or 'month'";
  return null;
}

promotionDetailsRouter.post('/period-benefits', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  const err = validatePeriodBenefit(req.body);
  if (err) return res.status(400).json({ error: err });
  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

  const { charge_type_id, quantity, frequency_interval, frequency_unit, enabled } = req.body;
  try {
    const row = await insertAndFetch(
      'INSERT INTO promotion_period_benefits (gym_id, promotion_id, charge_type_id, quantity, frequency_interval, frequency_unit, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [gymId, promotionId, charge_type_id, parseInt(quantity, 10), parseInt(frequency_interval, 10), frequency_unit, enabled != null ? (enabled ? 1 : 0) : 1],
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

  const { charge_type_id, quantity, frequency_interval, frequency_unit, enabled } = req.body;
  try {
    const { rowCount } = await db.query(
      `UPDATE promotion_period_benefits
         SET charge_type_id = ?, quantity = ?, frequency_interval = ?, frequency_unit = ?, enabled = ?
       WHERE id = ? AND promotion_id = ? AND gym_id = ?`,
      [charge_type_id, parseInt(quantity, 10), parseInt(frequency_interval, 10), frequency_unit,
       enabled != null ? (enabled ? 1 : 0) : 1, pbId, promotionId, gymId],
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
    const { rowCount } = await db.query(
      'DELETE FROM promotion_period_benefits WHERE id = ? AND promotion_id = ? AND gym_id = ?',
      [req.params.pbId, promotionId, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Period benefit not found' });
    res.status(204).send();
  } catch (err) { next(err); }
});
