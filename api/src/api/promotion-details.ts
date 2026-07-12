import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

export const promotionDetailsRouter = Router({ mergeParams: true });

async function verifyPromotion(gymId: string, promotionId: number) {
  const { rows } = await db.query('SELECT id FROM promotions WHERE id = ? AND gym_id = ?', [promotionId, gymId]);
  return rows.length > 0;
}

/* ---------- plan targeting (P4.2) ---------- */

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

/* ---------- charge benefits (P4.2) ---------- */

promotionDetailsRouter.get('/charge-benefits', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  const { rows } = await db.query(
    'SELECT * FROM promotion_charge_benefits WHERE promotion_id = ? AND gym_id = ? ORDER BY id ASC',
    [promotionId, gymId],
  );
  res.json(rows);
});

promotionDetailsRouter.post('/charge-benefits', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  const { charge_type_id, action_type_id, value } = req.body;
  if (!charge_type_id || !action_type_id) return res.status(400).json({ error: 'charge_type_id and action_type_id are required' });
  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });

  const { rows: actionRows } = await db.query('SELECT code FROM action_types WHERE id = ?', [action_type_id]);
  if (actionRows.length === 0) return res.status(404).json({ error: 'Action type not found' });
  const actionCode = actionRows[0].code;

  const parsedValue = value != null && value !== '' ? parseFloat(value) : null;
  if (actionCode === 'waive' && parsedValue !== null) {
    return res.status(400).json({ error: 'Waive actions must not carry a value' });
  }
  if (actionCode !== 'waive' && parsedValue === null) {
    return res.status(400).json({ error: 'This action requires a value' });
  }
  if (actionCode === 'percentage_discount' && parsedValue !== null && (parsedValue < 0 || parsedValue > 100)) {
    return res.status(400).json({ error: 'Percentage must be between 0 and 100' });
  }
  if (parsedValue !== null && parsedValue < 0) return res.status(400).json({ error: 'Value must be non-negative' });

  try {
    const { insertId } = await db.query(
      `INSERT INTO promotion_charge_benefits (gym_id, promotion_id, charge_type_id, action_type_id, value)
       VALUES (?, ?, ?, ?, ?)`,
      [gymId, promotionId, charge_type_id, action_type_id, parsedValue],
    );
    const { rows } = await db.query('SELECT * FROM promotion_charge_benefits WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
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

/* ---------- period benefits (P4.3) ---------- */

promotionDetailsRouter.get('/period-benefits', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const promotionId = (req.params as any).id;
  const { rows } = await db.query(
    'SELECT * FROM promotion_period_benefits WHERE promotion_id = ? AND gym_id = ? ORDER BY required_paid_months ASC',
    [promotionId, gymId],
  );
  res.json(rows);
});

promotionDetailsRouter.post('/period-benefits', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const promotionId = parseInt((req.params as any).id, 10);
  const { required_paid_months, granted_free_periods } = req.body;
  const paid = parseInt(required_paid_months, 10);
  const free = parseInt(granted_free_periods, 10);
  if (isNaN(paid) || paid <= 0 || isNaN(free) || free <= 0) {
    return res.status(400).json({ error: 'Both required_paid_months and granted_free_periods must be positive integers' });
  }
  if (!(await verifyPromotion(gymId, promotionId))) return res.status(404).json({ error: 'Promotion not found' });
  try {
    const { insertId } = await db.query(
      'INSERT INTO promotion_period_benefits (gym_id, promotion_id, required_paid_months, granted_free_periods) VALUES (?, ?, ?, ?)',
      [gymId, promotionId, paid, free],
    );
    const { rows } = await db.query('SELECT * FROM promotion_period_benefits WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
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
