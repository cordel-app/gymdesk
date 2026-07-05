import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';

/**
 * DEPRECATED compatibility alias for the pre-P1.5 Subscriptions API (#9).
 * Serves the old admin Subscriptions page against the renamed
 * user_memberships table. The legacy `plan` text column is still there
 * for rows whose old value didn't match any membership_plans.name.
 * Removed in P1.7 (#11) together with the old page.
 */
export const subscriptionsRouter = Router();

// Prefer the joined plan name when we backfilled it, otherwise the legacy text.
const COMPAT_SELECT = `
  SELECT um.id, um.gym_id, um.member_id,
         COALESCE(p.name, um.plan) AS plan,
         um.starts_at, um.ends_at, um.status, um.created_at
  FROM user_memberships um
  LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
`;

subscriptionsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${COMPAT_SELECT} WHERE um.gym_id = ? ORDER BY um.created_at DESC`, [gymId]);
  res.json(rows);
});

subscriptionsRouter.get('/:id', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rows } = await db.query(`${COMPAT_SELECT} WHERE um.id = ? AND um.gym_id = ?`, [req.params.id, gymId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });
  res.json(rows[0]);
});

subscriptionsRouter.post('/', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { member_id, plan, starts_at, ends_at } = req.body;
  if (!member_id || !plan || !starts_at) {
    return res.status(400).json({ error: 'member_id, plan and starts_at are required' });
  }
  // Try to resolve the legacy text to a real plan; leave legacy `plan` NULL
  // if it matches, so future edits go through the new flow cleanly.
  const { rows: matched } = await db.query(
    'SELECT id, base_price FROM membership_plans WHERE gym_id = ? AND LOWER(name) = LOWER(?) LIMIT 1',
    [gymId, plan],
  );
  const planId = matched[0]?.id ?? null;
  const basePrice = matched[0]?.base_price ?? null;
  try {
    const { insertId } = await db.query(
      `INSERT INTO user_memberships
       (member_id, gym_id, membership_plan_id, plan, base_price, final_price, starts_at, ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [member_id, gymId, planId, planId ? null : plan, basePrice, basePrice, starts_at, ends_at ?? null],
    );
    const { rows } = await db.query(`${COMPAT_SELECT} WHERE um.id = ?`, [insertId]);
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This member already has an active membership.' });
    throw err;
  }
});

subscriptionsRouter.put('/:id', requireRole('admin', 'staff'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { plan, starts_at, ends_at, status } = req.body;
  const { rowCount } = await db.query(
    `UPDATE user_memberships SET
      plan       = COALESCE(?, plan),
      starts_at  = COALESCE(?, starts_at),
      ends_at    = COALESCE(?, ends_at),
      status     = COALESCE(?, status)
     WHERE id = ? AND gym_id = ?`,
    [plan ?? null, starts_at ?? null, ends_at ?? null, status ?? null, req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Subscription not found' });
  const { rows } = await db.query(`${COMPAT_SELECT} WHERE um.id = ? AND um.gym_id = ?`, [req.params.id, gymId]);
  res.json(rows[0]);
});

subscriptionsRouter.delete('/:id', requireRole('admin'), async (req, res) => {
  const { gymId } = getTenantContext(req);
  const { rowCount } = await db.query(
    'DELETE FROM user_memberships WHERE id = ? AND gym_id = ?',
    [req.params.id, gymId],
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Subscription not found' });
  res.status(204).send();
});
