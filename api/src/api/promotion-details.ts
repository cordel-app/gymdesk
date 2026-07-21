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
    'SELECT * FROM promotion_charge_benefits WHERE promotion_id = ? AND gym_id = ? ORDER BY id ASC',
    [promotionId, gymId],
  );
  res.json(rows);
});

function validateChargeBenefit(actionCode: string, value: any) {
  const parsed = value != null && value !== '' ? parseFloat(value) : null;
  if (actionCode === 'waive' && parsed !== null) return 'Waive actions must not carry a value';
  if (actionCode !== 'waive' && parsed === null) return 'This action requires a value';
  if (actionCode === 'percentage_discount' && parsed !== null && (parsed < 0 || parsed > 100)) {
    return 'Percentage must be between 0 and 100';
  }
  if (parsed !== null && parsed < 0) return 'Value must be non-negative';
  return null;
}

promotionDetailsRouter.post('/charge-benefits', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  const { charge_type_id, action_type_id, value } = req.body;
  if (!charge_type_id || !action_type_id) return res.status(400).json({ error: 'charge_type_id and action_type_id are required' });
  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

  const { rows: actionRows } = await db.query('SELECT code FROM action_types WHERE id = ?', [action_type_id]);
  if (actionRows.length === 0) return res.status(404).json({ error: 'Action type not found' });
  const actionCode = actionRows[0].code;
  const err = validateChargeBenefit(actionCode, value);
  if (err) return res.status(400).json({ error: err });

  const parsedValue = value != null && value !== '' ? parseFloat(value) : null;
  try {
    const row = await insertAndFetch(
      `INSERT INTO promotion_charge_benefits (gym_id, promotion_id, charge_type_id, action_type_id, value)
       VALUES (?, ?, ?, ?, ?)`,
      [gymId, promotionId, charge_type_id, action_type_id, parsedValue],
      'SELECT * FROM promotion_charge_benefits WHERE id = ?',
      (id) => [id],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

promotionDetailsRouter.put('/charge-benefits/:cbId', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  const { cbId } = req.params;
  const { charge_type_id, action_type_id, value } = req.body;
  if (!charge_type_id || !action_type_id) return res.status(400).json({ error: 'charge_type_id and action_type_id are required' });

  const { rows: actionRows } = await db.query('SELECT code FROM action_types WHERE id = ?', [action_type_id]);
  if (actionRows.length === 0) return res.status(404).json({ error: 'Action type not found' });
  const err = validateChargeBenefit(actionRows[0].code, value);
  if (err) return res.status(400).json({ error: err });

  const parsedValue = value != null && value !== '' ? parseFloat(value) : null;
  try {
    const { rowCount } = await db.query(
      'UPDATE promotion_charge_benefits SET charge_type_id = ?, action_type_id = ?, value = ? WHERE id = ? AND promotion_id = ? AND gym_id = ?',
      [charge_type_id, action_type_id, parsedValue, cbId, promotionId, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Charge benefit not found' });
    const { rows } = await db.query('SELECT * FROM promotion_charge_benefits WHERE id = ?', [cbId]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

promotionDetailsRouter.delete('/charge-benefits/:cbId', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  const { rowCount } = await db.query(
    'DELETE FROM promotion_charge_benefits WHERE id = ? AND promotion_id = ? AND gym_id = ?',
    [req.params.cbId, promotionId, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Charge benefit not found' });
  res.status(204).send();
});

/* ---------- period benefits ---------- */

promotionDetailsRouter.get('/period-benefits', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  const { rows } = await db.query(
    `SELECT ppb.*, mp.name AS membership_plan_name, at.code AS action_code
     FROM promotion_period_benefits ppb
     JOIN membership_plans mp ON mp.id = ppb.membership_plan_id
     JOIN action_types at ON at.id = ppb.action_type_id
     WHERE ppb.promotion_id = ? AND ppb.gym_id = ?
     ORDER BY ppb.id ASC`,
    [promotionId, gymId],
  );
  res.json(rows);
});

function validatePeriodBenefit(actionCode: string, value: any, duration_months: any) {
  const dur = parseInt(duration_months, 10);
  if (isNaN(dur) || dur <= 0) return 'duration_months must be a positive integer';
  const parsed = value != null && value !== '' ? parseFloat(value) : null;
  if (actionCode === 'waive' && parsed !== null) return 'Waive actions must not carry a value';
  if (actionCode !== 'waive' && parsed === null) return 'This action requires a value';
  if (actionCode === 'percentage_discount' && parsed !== null && (parsed < 0 || parsed > 100)) {
    return 'Percentage must be between 0 and 100';
  }
  if (parsed !== null && parsed < 0) return 'Value must be non-negative';
  return null;
}

promotionDetailsRouter.post('/period-benefits', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  const { membership_plan_id, action_type_id, value, duration_months } = req.body;
  if (!membership_plan_id || !action_type_id) {
    return res.status(400).json({ error: 'membership_plan_id and action_type_id are required' });
  }
  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

  const { rows: actionRows } = await db.query('SELECT code FROM action_types WHERE id = ?', [action_type_id]);
  if (actionRows.length === 0) return res.status(404).json({ error: 'Action type not found' });
  const err = validatePeriodBenefit(actionRows[0].code, value, duration_months);
  if (err) return res.status(400).json({ error: err });

  const parsedValue = value != null && value !== '' ? parseFloat(value) : null;
  const dur = parseInt(duration_months, 10);
  try {
    const row = await insertAndFetch(
      'INSERT INTO promotion_period_benefits (gym_id, promotion_id, membership_plan_id, action_type_id, value, duration_months) VALUES (?, ?, ?, ?, ?, ?)',
      [gymId, promotionId, membership_plan_id, action_type_id, parsedValue, dur],
      'SELECT ppb.*, mp.name AS membership_plan_name, at.code AS action_code FROM promotion_period_benefits ppb JOIN membership_plans mp ON mp.id = ppb.membership_plan_id JOIN action_types at ON at.id = ppb.action_type_id WHERE ppb.id = ?',
      (id) => [id],
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

promotionDetailsRouter.put('/period-benefits/:pbId', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  const { pbId } = req.params;
  const { membership_plan_id, action_type_id, value, duration_months } = req.body;
  if (!membership_plan_id || !action_type_id) {
    return res.status(400).json({ error: 'membership_plan_id and action_type_id are required' });
  }

  const { rows: actionRows } = await db.query('SELECT code FROM action_types WHERE id = ?', [action_type_id]);
  if (actionRows.length === 0) return res.status(404).json({ error: 'Action type not found' });
  const err = validatePeriodBenefit(actionRows[0].code, value, duration_months);
  if (err) return res.status(400).json({ error: err });

  const parsedValue = value != null && value !== '' ? parseFloat(value) : null;
  const dur = parseInt(duration_months, 10);
  try {
    const { rowCount } = await db.query(
      'UPDATE promotion_period_benefits SET membership_plan_id = ?, action_type_id = ?, value = ?, duration_months = ? WHERE id = ? AND promotion_id = ? AND gym_id = ?',
      [membership_plan_id, action_type_id, parsedValue, dur, pbId, promotionId, gymId],
    );
    if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Period benefit not found' });
    const { rows } = await db.query(
      'SELECT ppb.*, mp.name AS membership_plan_name, at.code AS action_code FROM promotion_period_benefits ppb JOIN membership_plans mp ON mp.id = ppb.membership_plan_id JOIN action_types at ON at.id = ppb.action_type_id WHERE ppb.id = ?',
      [pbId],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

promotionDetailsRouter.delete('/period-benefits/:pbId', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  const { rowCount } = await db.query(
    'DELETE FROM promotion_period_benefits WHERE id = ? AND promotion_id = ? AND gym_id = ?',
    [req.params.pbId, promotionId, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Period benefit not found' });
  res.status(204).send();
});
