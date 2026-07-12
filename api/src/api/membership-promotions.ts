import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

/**
 * P4.4: apply/revoke promotions on a user_membership.
 *
 * Server recomputes final_price from the plan's base_price + charge benefits
 * on the 'membership_fee' charge type across all currently-applied promos.
 * Recomputation is server-only; the ledger records an 'adjustment' event.
 */

const SELECT = `
  SELECT ump.*, p.name AS promotion_name, p.stackable, p.starts_at, p.ends_at
  FROM user_membership_promotions ump
  JOIN promotions p ON p.id = ump.promotion_id
`;

export const membershipPromotionsRouter = Router({ mergeParams: true });

async function computeFinalPrice(tx: Tx, gymId: string, userMembershipId: number) {
  const { rows: umRows } = await tx.query(
    `SELECT um.id, um.member_id, um.membership_plan_id, um.base_price, um.final_price,
            p.base_price AS plan_base_price
     FROM user_memberships um
     JOIN membership_plans p ON p.id = um.membership_plan_id
     WHERE um.id = ? AND um.gym_id = ?`,
    [userMembershipId, gymId],
  );
  if (umRows.length === 0) return null;
  const um = umRows[0];
  // Start from base_price snapshot on the membership (preserves the plan-price
  // window semantics from P1.3), fall back to plan.base_price.
  let price = parseFloat(um.base_price ?? um.plan_base_price);

  const { rows: cbRows } = await tx.query(
    `SELECT pcb.value, at.code AS action_code, ct.code AS charge_code
     FROM user_membership_promotions ump
     JOIN promotion_charge_benefits pcb ON pcb.promotion_id = ump.promotion_id
     JOIN action_types at ON at.id = pcb.action_type_id
     JOIN charge_types ct ON ct.id = pcb.charge_type_id
     WHERE ump.user_membership_id = ? AND ump.status = 'applied'
       AND ct.code = 'membership_fee'`,
    [userMembershipId],
  );
  for (const cb of cbRows) {
    if (cb.action_code === 'waive') price = 0;
    else if (cb.action_code === 'percentage_discount') price -= price * (parseFloat(cb.value) / 100);
    else if (cb.action_code === 'fixed_discount') price -= parseFloat(cb.value);
  }
  if (price < 0) price = 0;
  return { price: Math.round(price * 100) / 100, member_id: um.member_id, previousFinal: um.final_price != null ? parseFloat(um.final_price) : null };
}

membershipPromotionsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const umId = (req.params as any).id;
  const { rows } = await db.query(
    `${SELECT} WHERE ump.user_membership_id = ? AND ump.gym_id = ? ORDER BY ump.applied_at DESC`,
    [umId, gymId],
  );
  res.json(rows);
});

membershipPromotionsRouter.post('/', requireRole('admin', 'staff'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const umId = parseInt((req.params as any).id, 10);
  const { promotion_id } = req.body;
  if (!promotion_id) return res.status(400).json({ error: 'promotion_id is required' });

  try {
    const applied = await db.transaction(async (tx) => {
      // Load target membership
      const { rows: umRows } = await tx.query(
        'SELECT id, member_id, membership_plan_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
        [umId, gymId],
      );
      if (umRows.length === 0) throw Object.assign(new Error('Membership not found'), { status: 404 });
      const um = umRows[0];

      // Load promotion
      const { rows: promoRows } = await tx.query(
        "SELECT id, stackable, status, starts_at, ends_at FROM promotions WHERE id = ? AND gym_id = ?",
        [promotion_id, gymId],
      );
      if (promoRows.length === 0) throw Object.assign(new Error('Promotion not found'), { status: 404 });
      const promo = promoRows[0];
      if (promo.status !== 'active') throw Object.assign(new Error('Promotion is inactive'), { status: 400 });
      const now = new Date();
      if (new Date(promo.starts_at) > now || new Date(promo.ends_at) < now) {
        throw Object.assign(new Error('Promotion is outside its active window'), { status: 400 });
      }

      // Check plan targeting
      const { rows: matchRows } = await tx.query(
        'SELECT 1 FROM promotion_membership_plans WHERE promotion_id = ? AND membership_plan_id = ? AND gym_id = ?',
        [promotion_id, um.membership_plan_id, gymId],
      );
      if (matchRows.length === 0) {
        throw Object.assign(new Error("Promotion doesn't target this membership's plan"), { status: 400 });
      }

      // Stackability
      if (!promo.stackable) {
        const { rows: existing } = await tx.query(
          "SELECT id FROM user_membership_promotions WHERE user_membership_id = ? AND status = 'applied'",
          [umId],
        );
        if (existing.length > 0) throw Object.assign(new Error('This promotion is not stackable with another already applied'), { status: 409 });
      }

      // Insert row (unique constraint catches double-apply)
      try {
        await tx.query(
          "INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status) VALUES (?, ?, ?, ?, 'applied')",
          [gymId, umId, promotion_id, userId],
        );
      } catch (e: any) {
        if (e.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('This promotion is already applied to this membership'), { status: 409 });
        throw e;
      }

      // Recompute final_price
      const calc = await computeFinalPrice(tx, gymId, umId);
      if (!calc) throw Object.assign(new Error('Recompute failed'), { status: 500 });
      const prevFinal = calc.previousFinal;
      await tx.query(
        'UPDATE user_memberships SET final_price = ? WHERE id = ? AND gym_id = ?',
        [calc.price, umId, gymId],
      );

      // Ledger: adjustment for the delta
      if (prevFinal !== null && Math.abs(prevFinal - calc.price) > 0.001) {
        const { rows: ctRows } = await tx.query("SELECT id FROM charge_types WHERE code = 'membership_fee'");
        const chargeTypeId = ctRows[0]?.id ?? null;
        await tx.query(
          `INSERT INTO billing_events
           (gym_id, user_membership_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, notes)
           VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, 'Promotion applied')`,
          [gymId, umId, calc.member_id, chargeTypeId, role === 'admin' ? 'admin' : 'employee', userId, calc.price - prevFinal],
        );
      }
      return { user_membership_id: umId, promotion_id, final_price: calc.price };
    });
    recordAudit(req, { action: 'apply_promotion', entityType: 'user_membership', entityId: umId, next: applied });
    res.status(201).json(applied);
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

membershipPromotionsRouter.delete('/:promotionId', requireRole('admin', 'staff'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const umId = parseInt((req.params as any).id, 10);
  const promotionId = parseInt(req.params.promotionId, 10);
  try {
    const result = await db.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        "UPDATE user_membership_promotions SET status = 'revoked' WHERE user_membership_id = ? AND promotion_id = ? AND gym_id = ? AND status = 'applied'",
        [umId, promotionId, gymId],
      );
      if (rowCount === 0) return null;
      const calc = await computeFinalPrice(tx, gymId, umId);
      if (!calc) return null;
      const prevFinal = calc.previousFinal;
      await tx.query('UPDATE user_memberships SET final_price = ? WHERE id = ? AND gym_id = ?', [calc.price, umId, gymId]);
      if (prevFinal !== null && Math.abs(prevFinal - calc.price) > 0.001) {
        const { rows: ctRows } = await tx.query("SELECT id FROM charge_types WHERE code = 'membership_fee'");
        const chargeTypeId = ctRows[0]?.id ?? null;
        await tx.query(
          `INSERT INTO billing_events
           (gym_id, user_membership_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, notes)
           VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, 'Promotion revoked')`,
          [gymId, umId, calc.member_id, chargeTypeId, role === 'admin' ? 'admin' : 'employee', userId, calc.price - prevFinal],
        );
      }
      return { final_price: calc.price };
    });
    if (!result) return res.status(404).json({ error: 'Applied promotion not found' });
    recordAudit(req, { action: 'revoke_promotion', entityType: 'user_membership', entityId: umId, next: { promotion_id: promotionId, ...result } });
    res.status(200).json(result);
  } catch (err) { next(err); }
});
