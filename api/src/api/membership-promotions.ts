import { Router } from 'express';
import { db, Tx } from '../infra/db';
import { getTenantContext, requireModuleWrite } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { applyPeriodBenefit, PromotionBenefitAction } from '../domain/promotionBenefits';
import { validatePromotionStacking } from '../domain/promotionStacking';

/**
 * P4.4: apply/revoke promotions on a user_membership.
 *
 * Server recomputes final_price from the plan's base_price + charge benefits
 * and (#487 stage 3) Membership Fee period benefits, across all
 * currently-applied promos. Recomputation is server-only; the ledger records
 * an 'adjustment' event. Recomputation only happens at these mutation points
 * (assignment, promotion apply/revoke) — there is no scheduled job that
 * reverts final_price on its own once a period benefit's duration_months
 * window lapses without a new mutation; that's a possible future stage 4/5.
 */

const SELECT = `
  SELECT ump.*, p.name AS promotion_name, p.description AS promotion_description,
         p.stackable, p.starts_at, p.ends_at
  FROM user_membership_promotions ump
  JOIN promotions p ON p.id = ump.promotion_id
`;

export const membershipPromotionsRouter = Router({ mergeParams: true });

interface PromotionSnapshot {
  name: string;
  description: string | null;
  stackable: boolean;
  starts_at: string;
  ends_at: string;
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  charge_benefits: Array<{ charge_type_code: string; charge_type_name: string; action: string; value: number | null }>;
  period_benefits: Array<{
    charge_type_code: string; charge_type_name: string; quantity: number;
    frequency_interval: number; frequency_unit: string; enabled: boolean;
    action: string | null; value: number | null; duration_months: number | null;
  }>;
  included_benefits: Array<{ charge_type_code: string; charge_type_name: string; quantity: number }>;
}

type Queryable = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };

type LiveBenefits = Pick<PromotionSnapshot, 'charge_benefits' | 'period_benefits' | 'included_benefits'>;

// Shared by buildPromotionSnapshot (below, applied at INSERT time) and the
// GET / handler's live-join fallback for rows applied before migration 149
// (snapshot IS NULL) — those never got a snapshot, so their benefit
// breakdown can only be read from the promotion's *current* definition.
// Exported for reuse by user-memberships.ts's Billing Events range
// computation (#511 stage 3), which needs the same Membership Fee
// charge/period benefits for legacy (snapshot IS NULL) promotion applications.
export async function fetchLiveBenefits(exec: Queryable, promotionId: number): Promise<LiveBenefits> {
  const { rows: chargeBenefits } = await exec.query(
    `SELECT ct.code AS charge_type_code, ct.name AS charge_type_name, pcb.action, pcb.value
     FROM promotion_charge_benefits pcb
     JOIN gym_charges gc ON gc.id = pcb.gym_charge_id
     JOIN charge_types ct ON ct.id = gc.charge_type_id
     WHERE pcb.promotion_id = ?`,
    [promotionId],
  );

  const { rows: periodBenefits } = await exec.query(
    `SELECT ct.code AS charge_type_code, ct.name AS charge_type_name,
            ppb.quantity, ppb.frequency_interval, ppb.frequency_unit, ppb.enabled,
            ppb.action, ppb.value, ppb.duration_months
     FROM promotion_period_benefits ppb
     JOIN charge_types ct ON ct.id = ppb.charge_type_id
     WHERE ppb.promotion_id = ?`,
    [promotionId],
  );

  const { rows: includedBenefits } = await exec.query(
    `SELECT ct.code AS charge_type_code, ct.name AS charge_type_name, pib.quantity
     FROM promotion_included_benefits pib
     JOIN charge_types ct ON ct.id = pib.charge_type_id
     WHERE pib.promotion_id = ?`,
    [promotionId],
  );

  return {
    charge_benefits: chargeBenefits.map((r: any) => ({
      charge_type_code: r.charge_type_code, charge_type_name: r.charge_type_name,
      action: r.action, value: r.value != null ? parseFloat(r.value) : null,
    })),
    period_benefits: periodBenefits.map((r: any) => ({
      charge_type_code: r.charge_type_code, charge_type_name: r.charge_type_name,
      quantity: r.quantity, frequency_interval: r.frequency_interval, frequency_unit: r.frequency_unit,
      enabled: !!r.enabled, action: r.action ?? null, value: r.value != null ? parseFloat(r.value) : null,
      duration_months: r.duration_months ?? null,
    })),
    included_benefits: includedBenefits.map((r: any) => ({
      charge_type_code: r.charge_type_code, charge_type_name: r.charge_type_name, quantity: r.quantity,
    })),
  };
}

// #511 (stage 2): captures everything needed to reproduce what a promotion
// granted at the moment it's applied to an Assigned Plan, so a later edit to
// the promotion's own definition (rename, discount change, deactivation)
// never rewrites the Assigned Plan's historical record. Mirrors the existing
// `user_membership_charge_benefits` assignment-time snapshot pattern (#376),
// just as a single JSON column instead of relational rows, since this data
// is display/history-only and never joined against for business logic.
async function buildPromotionSnapshot(tx: Tx, gymId: string, promotionId: number): Promise<PromotionSnapshot | null> {
  const { rows: promoRows } = await tx.query(
    `SELECT name, description, stackable, starts_at, ends_at, free_months, paid_months, bonus_months
     FROM promotions WHERE id = ? AND gym_id = ?`,
    [promotionId, gymId],
  );
  if (promoRows.length === 0) return null;
  const promo = promoRows[0];
  const benefits = await fetchLiveBenefits(tx, promotionId);

  return {
    name: promo.name,
    description: promo.description ?? null,
    stackable: !!promo.stackable,
    starts_at: promo.starts_at,
    ends_at: promo.ends_at,
    free_months: promo.free_months ?? null,
    paid_months: promo.paid_months ?? null,
    bonus_months: promo.bonus_months ?? null,
    ...benefits,
  };
}

// Merges a row's `snapshot` (if present — only populated going forward, see
// migration 149) over its live-joined promotion fields, so historically
// applied promotions display what was actually granted rather than the
// promotion's current, possibly since-edited, definition. Rows applied
// before migration 149 have no snapshot; the caller (GET / below) fills
// their benefit arrays from a live join instead.
async function withSnapshot(row: any) {
  const snap = row.snapshot as PromotionSnapshot | null;
  if (snap) {
    return {
      ...row,
      promotion_name: snap.name,
      promotion_description: snap.description,
      stackable: snap.stackable,
      starts_at: snap.starts_at,
      ends_at: snap.ends_at,
      free_months: snap.free_months,
      paid_months: snap.paid_months,
      bonus_months: snap.bonus_months,
      charge_benefits: snap.charge_benefits,
      period_benefits: snap.period_benefits,
      included_benefits: snap.included_benefits,
    };
  }
  const live = await fetchLiveBenefits(db, row.promotion_id);
  return { ...row, ...live };
}

async function computeFinalPrice(tx: Tx, gymId: string, userMembershipId: number) {
  const { rows: umRows } = await tx.query(
    `SELECT um.id, um.member_id, um.membership_plan_id, um.base_price, um.final_price
     FROM user_memberships um
     WHERE um.id = ? AND um.gym_id = ?`,
    [userMembershipId, gymId],
  );
  if (umRows.length === 0) return null;
  const um = umRows[0];
  // base_price is snapshotted onto the membership at assignment time (see
  // effectivePrice() in user-memberships.ts) and is never null — membership_plans
  // itself has carried no price column since migration 058, so there is no plan
  // fallback to join for.
  let price = parseFloat(um.base_price);

  const { rows: cbRows } = await tx.query(
    `SELECT pcb.value, pcb.action AS action_code, ct.code AS charge_code
     FROM user_membership_promotions ump
     JOIN promotion_charge_benefits pcb ON pcb.promotion_id = ump.promotion_id
     JOIN gym_charges gc ON gc.id = pcb.gym_charge_id
     JOIN charge_types ct ON ct.id = gc.charge_type_id
     WHERE ump.user_membership_id = ? AND ump.status = 'applied'
       AND ct.code = 'membership_fee'`,
    [userMembershipId],
  );
  for (const cb of cbRows) {
    price = applyPeriodBenefit(price, cb.action_code as PromotionBenefitAction, cb.value != null ? parseFloat(cb.value) : null);
  }

  // #487 stage 3: Period Benefits' action/value (stage 1) now affects real
  // billing too, gated by `duration_months` counted from when the promotion
  // was applied (`ump.applied_at`) — unlike Charge Benefits, which apply for
  // as long as the promotion itself is applied. A NULL duration_months means
  // no expiration. `quantity`/`frequency_interval`/`frequency_unit` are left
  // alone here: they describe how a count-based benefit (e.g. free sessions)
  // recurs, not whether the Membership Fee action is currently in effect.
  const { rows: ppbRows } = await tx.query(
    `SELECT ppb.value, ppb.action AS action_code
     FROM user_membership_promotions ump
     JOIN promotion_period_benefits ppb ON ppb.promotion_id = ump.promotion_id
     JOIN charge_types ct ON ct.id = ppb.charge_type_id
     WHERE ump.user_membership_id = ? AND ump.status = 'applied'
       AND ct.code = 'membership_fee' AND ppb.enabled = 1 AND ppb.action IS NOT NULL
       AND (ppb.duration_months IS NULL OR ump.applied_at + INTERVAL ppb.duration_months MONTH > NOW())`,
    [userMembershipId],
  );
  for (const ppb of ppbRows) {
    price = applyPeriodBenefit(price, ppb.action_code as PromotionBenefitAction, ppb.value != null ? parseFloat(ppb.value) : null);
  }

  return { price, member_id: um.member_id, previousFinal: um.final_price != null ? parseFloat(um.final_price) : null };
}

/**
 * #628: validates a whole set of Promotions against the Membership Plan they
 * are about to be assigned with, *before* anything is written.
 *
 * It re-states, over N promotions at once, exactly the per-promotion checks
 * `applyPromotionToMembership` runs one at a time (exists / active / inside
 * its window / targets this plan), plus the cross-promotion stacking rule
 * from `validatePromotionStacking`. Assigning a Plan creates the membership
 * first and applies the Promotions right after, so an invalid selection has
 * to be rejected up front — otherwise the assignment would already be
 * persisted by the time the first apply fails.
 */
export async function validatePromotionSelection(
  gymId: string,
  membershipPlanId: number,
  promotionIds: number[],
): Promise<{ status: number; error: string } | null> {
  if (promotionIds.length === 0) return null;

  const placeholders = promotionIds.map(() => '?').join(',');
  const { rows } = await db.query(
    `SELECT id, stackable, lifecycle_status, starts_at, ends_at
     FROM promotions
     WHERE id IN (${placeholders}) AND gym_id = ? AND lifecycle_status != 'deleted'`,
    [...promotionIds, gymId],
  );

  const byId = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));
  const now = new Date();
  for (const id of promotionIds) {
    const promo = byId.get(id);
    if (!promo) return { status: 404, error: `Promotion ${id} not found` };
    if (promo.lifecycle_status !== 'active') return { status: 400, error: `Promotion ${id} is inactive` };
    if (new Date(promo.starts_at) > now || new Date(promo.ends_at) < now) {
      return { status: 400, error: `Promotion ${id} is outside its active window` };
    }
  }

  const { rows: targeted } = await db.query(
    `SELECT promotion_id FROM promotion_membership_plans
     WHERE promotion_id IN (${placeholders}) AND membership_plan_id = ? AND gym_id = ?`,
    [...promotionIds, membershipPlanId, gymId],
  );
  const targetedIds = new Set(targeted.map((r: any) => Number(r.promotion_id)));
  for (const id of promotionIds) {
    if (!targetedIds.has(id)) {
      return { status: 400, error: `Promotion ${id} doesn't target this membership's plan` };
    }
  }

  const stacking = validatePromotionStacking(
    promotionIds.map((id) => ({ id, stackable: !!byId.get(id).stackable })),
  );
  if (!stacking.ok) return { status: 400, error: stacking.error };

  return null;
}

export async function applyPromotionToMembership(
  gymId: string,
  userId: string,
  source: string,
  umId: number,
  promotionId: number,
): Promise<{ user_membership_id: number; promotion_id: number; final_price: number }> {
  return db.transaction(async (tx) => {
    const { rows: umRows } = await tx.query(
      'SELECT id, member_id, membership_plan_id, status FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE',
      [umId, gymId],
    );
    if (umRows.length === 0) throw Object.assign(new Error('Membership not found'), { status: 404 });
    const um = umRows[0];

    const { rows: promoRows } = await tx.query(
      "SELECT id, stackable, lifecycle_status, starts_at, ends_at FROM promotions WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'",
      [promotionId, gymId],
    );
    if (promoRows.length === 0) throw Object.assign(new Error('Promotion not found'), { status: 404 });
    const promo = promoRows[0];
    if (promo.lifecycle_status !== 'active') throw Object.assign(new Error('Promotion is inactive'), { status: 400 });
    const now = new Date();
    if (new Date(promo.starts_at) > now || new Date(promo.ends_at) < now) {
      throw Object.assign(new Error('Promotion is outside its active window'), { status: 400 });
    }

    const { rows: matchRows } = await tx.query(
      'SELECT 1 FROM promotion_membership_plans WHERE promotion_id = ? AND membership_plan_id = ? AND gym_id = ?',
      [promotionId, um.membership_plan_id, gymId],
    );
    if (matchRows.length === 0) {
      throw Object.assign(new Error("Promotion doesn't target this membership's plan"), { status: 400 });
    }

    if (!promo.stackable) {
      const { rows: existing } = await tx.query(
        "SELECT id FROM user_membership_promotions WHERE user_membership_id = ? AND status = 'applied'",
        [umId],
      );
      if (existing.length > 0) throw Object.assign(new Error('This promotion is not stackable with another already applied'), { status: 409 });
    }

    const snapshot = await buildPromotionSnapshot(tx, gymId, promotionId);
    try {
      await tx.query(
        "INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status, snapshot) VALUES (?, ?, ?, ?, 'applied', ?)",
        [gymId, umId, promotionId, userId, snapshot != null ? JSON.stringify(snapshot) : null],
      );
    } catch (e: any) {
      if (e.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('This promotion is already applied to this membership'), { status: 409 });
      throw e;
    }

    const calc = await computeFinalPrice(tx, gymId, umId);
    if (!calc) throw Object.assign(new Error('Recompute failed'), { status: 500 });
    const prevFinal = calc.previousFinal;
    await tx.query('UPDATE user_memberships SET final_price = ? WHERE id = ? AND gym_id = ?', [calc.price, umId, gymId]);

    if (prevFinal !== null && Math.abs(prevFinal - calc.price) > 0.001) {
      const { rows: ctRows } = await tx.query("SELECT id FROM charge_types WHERE code = 'membership_fee'");
      const chargeTypeId = ctRows[0]?.id ?? null;
      await tx.query(
        `INSERT INTO billing_events
         (gym_id, user_membership_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, notes)
         VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, 'Promotion applied')`,
        [gymId, umId, calc.member_id, chargeTypeId, source, userId, calc.price - prevFinal],
      );
    }
    return { user_membership_id: umId, promotion_id: promotionId, final_price: calc.price };
  });
}

// #511 (stage 3): shared by GET / here and GET /user-memberships/:id's
// expanded-detail response (see user-memberships.ts), so both surfaces list
// exactly the same applied-promotions data instead of duplicating the query.
export async function fetchAppliedPromotions(gymId: string, umId: string | number) {
  const { rows } = await db.query(
    `${SELECT} WHERE ump.user_membership_id = ? AND ump.gym_id = ? ORDER BY ump.applied_at DESC`,
    [umId, gymId],
  );
  return Promise.all(rows.map(withSnapshot));
}

membershipPromotionsRouter.get('/', async (req, res) => {
  const { gymId } = getTenantContext(req);
  const umId = (req.params as any).id;
  res.json(await fetchAppliedPromotions(gymId, umId));
});

membershipPromotionsRouter.post('/', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
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
        "SELECT id, stackable, lifecycle_status, starts_at, ends_at FROM promotions WHERE id = ? AND gym_id = ? AND lifecycle_status != 'deleted'",
        [promotion_id, gymId],
      );
      if (promoRows.length === 0) throw Object.assign(new Error('Promotion not found'), { status: 404 });
      const promo = promoRows[0];
      if (promo.lifecycle_status !== 'active') throw Object.assign(new Error('Promotion is inactive'), { status: 400 });
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
      const snapshot = await buildPromotionSnapshot(tx, gymId, promotion_id);
      try {
        await tx.query(
          "INSERT INTO user_membership_promotions (gym_id, user_membership_id, promotion_id, applied_by, status, snapshot) VALUES (?, ?, ?, ?, 'applied', ?)",
          [gymId, umId, promotion_id, userId, snapshot != null ? JSON.stringify(snapshot) : null],
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

membershipPromotionsRouter.delete('/:promotionId', requireModuleWrite('PAYMENTS'), async (req, res, next) => {
  const { gymId, userId, role } = getTenantContext(req);
  const umId = parseInt((req.params as any).id, 10);
  const promotionId = parseInt(String(req.params.promotionId), 10);
  try {
    const result = await db.transaction(async (tx) => {
      // #511 (stage 3): revoked_at stamps precisely when this promotion
      // stopped affecting billing, so the Billing Events range calculation
      // (assignedPlanBillingEvents.ts) can tell which persisted events fell
      // inside vs. outside its applied window, independent of the row's
      // `status` (kept for backward compatibility / existing callers).
      const { rowCount } = await tx.query(
        "UPDATE user_membership_promotions SET status = 'revoked', revoked_at = UTC_TIMESTAMP() WHERE user_membership_id = ? AND promotion_id = ? AND gym_id = ? AND status = 'applied'",
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
