import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

const STATUSES = ['active', 'inactive'];

export const membershipPlansRouter = Router();

membershipPlansRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  const { rows } = await db.query(
    `SELECT * FROM membership_plans WHERE gym_id = ?${status ? ' AND status = ?' : ''} ORDER BY name ASC`,
    status ? [gymId, status] : [gymId],
  );
  res.json(rows);
});

membershipPlansRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(
    'SELECT * FROM membership_plans WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Plan not found' });
  res.json(rows[0]);
});

membershipPlansRouter.post('/', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, base_price, status } = req.body;
  if (!name || base_price == null) return res.status(400).json({ error: 'name and base_price are required' });
  const parsed = parseFloat(base_price);
  if (isNaN(parsed) || parsed < 0) return res.status(400).json({ error: 'base_price must be a non-negative number' });
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  try {
    const { insertId } = await db.query(
      'INSERT INTO membership_plans (name, description, base_price, status, gym_id) VALUES (?, ?, ?, ?, ?)',
      [name.trim(), description ?? null, parsed, status ?? 'active', gymId],
    );
    const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A plan with this name already exists.' });
    next(err);
  }
});

membershipPlansRouter.put('/:id', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  const { name, description, base_price, status } = req.body;
  const parsed = base_price != null ? parseFloat(base_price) : null;
  if (parsed !== null && (isNaN(parsed) || parsed < 0)) {
    return res.status(400).json({ error: 'base_price must be a non-negative number' });
  }
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE membership_plans SET
        name        = COALESCE(?, name),
        description = IF(?, ?, description),
        base_price  = COALESCE(?, base_price),
        status      = COALESCE(?, status)
       WHERE id = ? AND gym_id = ?`,
      [
        name?.trim() ?? null,
        'description' in req.body ? 1 : 0, description ?? null,
        parsed, status ?? null,
        req.params.id, gymId,
      ],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Plan not found' });
    const { rows } = await db.query('SELECT * FROM membership_plans WHERE id = ? AND gym_id = ?', [req.params.id, gymId]);
    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A plan with this name already exists.' });
    next(err);
  }
});

membershipPlansRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM membership_plans WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Plan not found' });
  res.status(204).send();
});

// ─── Nested: time-boxed prices (P1.3 #7) ─────────────────────────────────────

// Confirms the plan exists in this gym before touching its prices.
async function planExists(planId: string, gymId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM membership_plans WHERE id = ? AND gym_id = ?', [planId, gymId]);
  return rows.length > 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validates window fields; returns { from, to } (to may be null) or an error string.
function parsePriceBody(body: any): { price: number; from: string; to: string | null } | string {
  const { price, valid_from, valid_to } = body;
  const parsed = parseFloat(price);
  if (price == null || isNaN(parsed) || parsed < 0) return 'price must be a non-negative number';
  if (!valid_from || !DATE_RE.test(valid_from)) return 'valid_from is required (YYYY-MM-DD)';
  const to = valid_to == null || valid_to === '' ? null : valid_to;
  if (to !== null && !DATE_RE.test(to)) return 'valid_to must be a date (YYYY-MM-DD) or empty';
  if (to !== null && to < valid_from) return 'valid_to must be on or after valid_from';
  return { price: parsed, from: valid_from, to };
}

// Any existing row whose window overlaps [from, to] (NULL to = open-ended).
// Two ranges overlap when each starts on/before the other ends.
async function overlaps(planId: string, from: string, to: string | null, excludeId?: string): Promise<boolean> {
  const params: any[] = [planId, from];
  let sql = `SELECT 1 FROM membership_plan_prices
             WHERE membership_plan_id = ?
               AND (valid_to IS NULL OR valid_to >= ?)`;   // existing ends on/after new starts
  if (to === null) {
    // new window is open-ended → overlaps anything ending at/after `from` (already covered)
  } else {
    sql += ' AND valid_from <= ?';                          // existing starts on/before new ends
    params.push(to);
  }
  if (excludeId) { sql += ' AND id <> ?'; params.push(excludeId); }
  sql += ' LIMIT 1';
  const { rows } = await db.query(sql, params);
  return rows.length > 0;
}

membershipPlansRouter.get('/:id/prices', async (req, res) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { rows } = await db.query(
    'SELECT * FROM membership_plan_prices WHERE membership_plan_id = ? AND gym_id = ? ORDER BY valid_from ASC',
    [req.params.id, gymId],
  );
  res.json(rows);
});

membershipPlansRouter.post('/:id/prices', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const parsed = parsePriceBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  if (await overlaps(req.params.id, parsed.from, parsed.to)) {
    return res.status(400).json({ error: 'This validity window overlaps an existing price for this plan.' });
  }
  try {
    const { insertId } = await db.query(
      'INSERT INTO membership_plan_prices (membership_plan_id, gym_id, price, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, gymId, parsed.price, parsed.from, parsed.to],
    );
    const { rows } = await db.query('SELECT * FROM membership_plan_prices WHERE id = ?', [insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

membershipPlansRouter.put('/:id/prices/:priceId', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const parsed = parsePriceBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  if (await overlaps(req.params.id, parsed.from, parsed.to, req.params.priceId)) {
    return res.status(400).json({ error: 'This validity window overlaps an existing price for this plan.' });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE membership_plan_prices SET price = ?, valid_from = ?, valid_to = ?
       WHERE id = ? AND membership_plan_id = ? AND gym_id = ?`,
      [parsed.price, parsed.from, parsed.to, req.params.priceId, req.params.id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Price not found' });
    const { rows } = await db.query('SELECT * FROM membership_plan_prices WHERE id = ?', [req.params.priceId]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

membershipPlansRouter.delete('/:id/prices/:priceId', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM membership_plan_prices WHERE id = ? AND membership_plan_id = ? AND gym_id = ?',
    [req.params.priceId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Price not found' });
  res.status(204).send();
});

// ─── Nested: benefits (P1.4 #8) ──────────────────────────────────────────────

const RECURRENCES = [null, 'monthly', 'yearly'];

function parseBenefitBody(body: any):
  | { benefit_type_id: number; quantity: number | null; duration_days: number | null; recurrence: string | null; valid_from: string | null; valid_to: string | null }
  | string
{
  const btId = Number(body.benefit_type_id);
  if (!Number.isInteger(btId) || btId <= 0) return 'benefit_type_id is required';
  const qty = body.quantity == null || body.quantity === '' ? null : Number(body.quantity);
  if (qty !== null && (!Number.isInteger(qty) || qty <= 0)) return 'quantity must be a positive integer';
  const dur = body.duration_days == null || body.duration_days === '' ? null : Number(body.duration_days);
  if (dur !== null && (!Number.isInteger(dur) || dur <= 0)) return 'duration_days must be a positive integer';
  const rec = body.recurrence == null || body.recurrence === '' ? null : body.recurrence;
  if (!RECURRENCES.includes(rec)) return 'recurrence must be monthly, yearly, or empty';
  const from = body.valid_from == null || body.valid_from === '' ? null : body.valid_from;
  const to   = body.valid_to   == null || body.valid_to   === '' ? null : body.valid_to;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (from !== null && !dateRe.test(from)) return 'valid_from must be YYYY-MM-DD';
  if (to !== null && !dateRe.test(to))     return 'valid_to must be YYYY-MM-DD';
  if (from !== null && to !== null && to < from) return 'valid_to must be on or after valid_from';
  return { benefit_type_id: btId, quantity: qty, duration_days: dur, recurrence: rec, valid_from: from, valid_to: to };
}

async function benefitTypeIsActive(id: number): Promise<boolean> {
  const { rows } = await db.query('SELECT active FROM benefit_types WHERE id = ?', [id]);
  return rows.length > 0 && rows[0].active === 1;
}

membershipPlansRouter.get('/:id/benefits', async (req, res) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const { rows } = await db.query(
    `SELECT mpb.*, bt.code AS benefit_code
     FROM membership_plan_benefits mpb
     JOIN benefit_types bt ON bt.id = mpb.benefit_type_id
     WHERE mpb.membership_plan_id = ? AND mpb.gym_id = ?
     ORDER BY mpb.id ASC`,
    [req.params.id, gymId],
  );
  res.json(rows);
});

membershipPlansRouter.post('/:id/benefits', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const parsed = parseBenefitBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  if (!(await benefitTypeIsActive(parsed.benefit_type_id))) {
    return res.status(400).json({ error: 'This benefit type is not available yet.' });
  }
  try {
    const { insertId } = await db.query(
      `INSERT INTO membership_plan_benefits
       (membership_plan_id, gym_id, benefit_type_id, quantity, duration_days, recurrence, valid_from, valid_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, gymId, parsed.benefit_type_id, parsed.quantity, parsed.duration_days, parsed.recurrence, parsed.valid_from, parsed.valid_to],
    );
    const { rows } = await db.query(
      `SELECT mpb.*, bt.code AS benefit_code FROM membership_plan_benefits mpb
       JOIN benefit_types bt ON bt.id = mpb.benefit_type_id WHERE mpb.id = ?`,
      [insertId],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

membershipPlansRouter.put('/:id/benefits/:benefitId', requireRole('admin'), async (req, res, next) => {
  const { gymId } = getTenantContext(req);
  if (!(await planExists(req.params.id, gymId))) return res.status(404).json({ error: 'Plan not found' });
  const parsed = parseBenefitBody(req.body);
  if (typeof parsed === 'string') return res.status(400).json({ error: parsed });
  if (!(await benefitTypeIsActive(parsed.benefit_type_id))) {
    return res.status(400).json({ error: 'This benefit type is not available yet.' });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE membership_plan_benefits
       SET benefit_type_id = ?, quantity = ?, duration_days = ?, recurrence = ?, valid_from = ?, valid_to = ?
       WHERE id = ? AND membership_plan_id = ? AND gym_id = ?`,
      [parsed.benefit_type_id, parsed.quantity, parsed.duration_days, parsed.recurrence, parsed.valid_from, parsed.valid_to,
       req.params.benefitId, req.params.id, gymId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Benefit not found' });
    const { rows } = await db.query(
      `SELECT mpb.*, bt.code AS benefit_code FROM membership_plan_benefits mpb
       JOIN benefit_types bt ON bt.id = mpb.benefit_type_id WHERE mpb.id = ?`,
      [req.params.benefitId],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

membershipPlansRouter.delete('/:id/benefits/:benefitId', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM membership_plan_benefits WHERE id = ? AND membership_plan_id = ? AND gym_id = ?',
    [req.params.benefitId, req.params.id, gymId],
  );
  if ((rowCount ?? 0) === 0) return res.status(404).json({ error: 'Benefit not found' });
  res.status(204).send();
});
