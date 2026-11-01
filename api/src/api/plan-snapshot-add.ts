import type { Tx } from '../infra/db';
import { ensureSchedule } from './product-set-configuration';
import { copyProductTargetApplications } from './product-set-bridge';
import { syncPlanSnapshot } from './plan-snapshot-sync';
import { allocateSchedule, type ExistingSchedule } from '../domain/scheduleAllocation';
import { toPlanDurationRepeats } from '../domain/planDuration';

/**
 * #2125 stage 9 — a ProductSet version holding **more than one** Membership Plan.
 *
 * The legacy rows (`product_set_plan_snapshots` and the `user_membership_*` benefit tables) hold
 * one plan per version, so a second plan has no legacy home: it is written straight into the plan
 * snapshot tables (`source_plan_snapshot_id` NULL — a *native* snapshot), which `syncPlanSnapshot()`
 * leaves alone, and it is carried onto each successor version by `copyNativePlanSnapshots()`.
 *
 * Oscar's rule for its calendar: everything with the same periodicity bills on the same day, so the
 * plan joins the schedule of its cadence (`allocateSchedule()`); the engine prorates the stretch
 * from its start to that schedule's next date (`SimulationAssignment.alignTo`, stage 8).
 */

const toDateOnly = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

const ITEM_NAME_EXPR = "COALESCE(gc.name, ct.name, CONCAT('Product #', gc.id))";
const ITEM_TYPE_EXPR = "COALESCE(gc.type, 'other')";

const PLAN_TABLES = [
  { category: 'session', plan: 'membership_plan_session', snapshot: 'plan_session_snapshots', extra: 'frequency' },
  { category: 'oneoff', plan: 'membership_plan_oneoff', snapshot: 'plan_oneoff_snapshots', extra: null },
  { category: 'periodical', plan: 'membership_plan_periodical', snapshot: 'plan_periodical_snapshots', extra: 'schedule_id' },
] as const;

export async function addPlanSnapshotToVersion(tx: Tx, input: {
  gymId: string; productSetId: number; memberId: number; membershipPlanId: number;
  membershipFeePrice: number | null; startsAt: string; actor?: string | null;
  declinedBenefits?: Array<{ section: string; product_id: number }>;
}): Promise<number> {
  const { gymId, productSetId, membershipPlanId } = input;
  const { rows: setRows } = await tx.query<any>(
    'SELECT root_product_set_id, status FROM product_sets WHERE id = ? AND gym_id = ?', [productSetId, gymId]);
  if (!setRows[0]) throw new Error('ProductSet not found');
  const rootId = Number(setRows[0].root_product_set_id ?? productSetId);

  const { rows: planRows } = await tx.query<any>(
    `SELECT p.free_periods, p.paid_periods, p.bonus_periods, p.pay_beforehand_periods,
            bp.recurring_billing_interval, bp.recurring_billing_unit, bp.auto_renew
       FROM membership_plans p
       LEFT JOIN billing_policies bp ON bp.membership_plan_id = p.id AND bp.gym_id = p.gym_id
      WHERE p.id = ? AND p.gym_id = ?`, [membershipPlanId, gymId]);
  const plan = planRows[0];
  if (!plan) throw new Error('Membership Plan not found');

  // The plan joins the schedule of its periodicity (one rule, `allocateSchedule()`).
  let scheduleId: number | null = null;
  if (plan.recurring_billing_interval != null && plan.recurring_billing_unit != null) {
    const cadence = { interval: Number(plan.recurring_billing_interval), unit: plan.recurring_billing_unit } as const;
    const { rows: sched } = await tx.query<any>(
      `SELECT id, schedule_key, anchor_date, cadence_interval, cadence_unit
         FROM product_set_schedules WHERE root_product_set_id = ?`, [rootId]);
    const schedules: ExistingSchedule[] = sched.map((r: any) => ({
      id: Number(r.id), key: String(r.schedule_key), anchorDate: toDateOnly(r.anchor_date),
      cadence: { interval: Number(r.cadence_interval), unit: r.cadence_unit },
    }));
    const allocation = allocateSchedule({ cadence, purchaseDate: input.startsAt, schedules });
    if (allocation.kind === 'new') {
      scheduleId = await ensureSchedule(tx, {
        gymId, rootProductSetId: rootId, key: allocation.key, anchorDate: allocation.anchorDate,
        cadenceInterval: cadence.interval, cadenceUnit: cadence.unit,
      });
    } else {
      scheduleId = schedules.find((s) => s.key === allocation.key)?.id ?? null;
    }
  }

  const { insertId } = await tx.query(
    `INSERT INTO plan_snapshots
       (gym_id, product_set_id, member_id, membership_plan_id, status, is_inherited, starts_at, schedule_id,
        membership_fee_price, free_periods, paid_periods, bonus_periods, pay_beforehand_periods,
        auto_renew, recurring_billing_interval, recurring_billing_unit, created_by)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [gymId, productSetId, input.memberId, membershipPlanId, setRows[0].status, input.startsAt, scheduleId,
      input.membershipFeePrice ?? null, plan.free_periods ?? null, plan.paid_periods ?? null,
      plan.bonus_periods ?? null, plan.pay_beforehand_periods ?? null,
      toPlanDurationRepeats(plan.auto_renew ?? false) ? 1 : 0,
      plan.recurring_billing_interval ?? null, plan.recurring_billing_unit ?? null, input.actor ?? null]);

  await tx.query(
    'INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
    [gymId, insertId, input.memberId]);

  for (const t of PLAN_TABLES) {
    const declined = (input.declinedBenefits ?? []).filter((d) => d.section === t.category).map((d) => d.product_id);
    const declinedClause = declined.length > 0 ? `AND b.product_id NOT IN (${declined.map(() => '?').join(',')})` : '';
    const sessionFrequency = t.category === 'session';
    await tx.query(
      `INSERT INTO ${t.snapshot}
         (gym_id, plan_snapshot_id, product_id, quantity, item_name, item_type, item_billing_frequency,
          unit_price, currency, \`action\`, \`value\`, mandatory${sessionFrequency ? ', frequency' : ''})
       SELECT ?, ?, b.product_id, b.quantity, ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR},
              gc.billing_frequency, COALESCE(gc.amount, 0), gc.currency, b.\`action\`, b.\`value\`, b.mandatory
              ${sessionFrequency ? ', b.frequency' : ''}
         FROM ${t.plan} b
         JOIN products gc ON gc.id = b.product_id
         LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
        WHERE b.membership_plan_id = ? AND b.gym_id = ? ${declinedClause}`,
      [gymId, insertId, membershipPlanId, gymId, ...declined]);
  }
  return Number(insertId);
}

/**
 * Copies one plan snapshot (and everything hanging off it: beneficiaries, included Products,
 * Promotion applications with the Products they grant) onto another version as an inherited copy.
 * The copy is native — it has no legacy twin — and keeps the assignment the original is the contract
 * of (`source_user_membership_id`).
 */
export async function copyPlanSnapshotToVersion(tx: Tx, gymId: string, fromSnapshotId: number, toSetId: number): Promise<number> {
  const { insertId } = await tx.query(
    `INSERT INTO plan_snapshots
       (gym_id, product_set_id, member_id, membership_plan_id, status, is_inherited, starts_at, ends_at, closed_at,
        schedule_id, plan_price_id, base_price, discount_reason, discount_expires_at, membership_fee_price,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods, personal_fee_benefit_action,
        personal_fee_benefit_value, auto_renew, recurring_billing_interval, recurring_billing_unit, origin,
        source_user_membership_id, created_by)
     SELECT s.gym_id, ?, s.member_id, s.membership_plan_id, ps.status, 1, s.starts_at, s.ends_at, NULL,
            s.schedule_id, s.plan_price_id, s.base_price, s.discount_reason, s.discount_expires_at, s.membership_fee_price,
            s.free_periods, s.paid_periods, s.bonus_periods, s.pay_beforehand_periods, s.personal_fee_benefit_action,
            s.personal_fee_benefit_value, s.auto_renew, s.recurring_billing_interval, s.recurring_billing_unit, s.origin,
            s.source_user_membership_id, s.created_by
       FROM plan_snapshots s JOIN product_sets ps ON ps.id = ?
      WHERE s.id = ? AND s.gym_id = ?`, [toSetId, toSetId, fromSnapshotId, gymId]);
  await tx.query(
    `INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner)
     SELECT gym_id, ?, member_id, is_owner FROM plan_snapshot_beneficiaries WHERE plan_snapshot_id = ?`,
    [insertId, fromSnapshotId]);
  for (const t of PLAN_TABLES) {
    const extra = t.extra ? `, ${t.extra}` : '';
    await tx.query(
      `INSERT INTO ${t.snapshot}
         (gym_id, plan_snapshot_id, product_id, quantity, item_name, item_type, unit_price, item_billing_frequency,
          currency, \`action\`, \`value\`, mandatory${extra})
       SELECT gym_id, ?, product_id, quantity, item_name, item_type, unit_price, item_billing_frequency,
              currency, \`action\`, \`value\`, mandatory${extra}
         FROM ${t.snapshot} WHERE plan_snapshot_id = ?`, [insertId, fromSnapshotId]);
  }
  const { rows: promos } = await tx.query<any>(
    'SELECT id FROM plan_promotion_snapshots WHERE plan_snapshot_id = ? ORDER BY id', [fromSnapshotId]);
  for (const promo of promos) {
    const { insertId: promoId } = await tx.query(
      `INSERT INTO plan_promotion_snapshots
         (gym_id, plan_snapshot_id, promotion_id, status, is_inherited, snapshot, applied_at, applied_by,
          consumed_at, revoked_at, created_by)
       SELECT gym_id, ?, promotion_id, status, 1, snapshot, applied_at, applied_by, consumed_at, revoked_at, created_by
         FROM plan_promotion_snapshots WHERE id = ?`, [insertId, promo.id]);
    for (const table of [
      'plan_promotion_session_product_snapshots', 'plan_promotion_oneoff_product_snapshots',
      'plan_promotion_periodical_product_snapshots',
    ]) {
      await tx.query(
        `INSERT INTO ${table}
           (gym_id, plan_promotion_snapshot_id, product_id, product_name, quantity, item_type,
            item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement)
         SELECT gym_id, ?, product_id, product_name, quantity, item_type, item_billing_frequency,
                unit_price, currency, \`action\`, \`value\`, requirement
           FROM ${table} WHERE plan_promotion_snapshot_id = ?`, [promoId, promo.id]);
    }
  }
  return Number(insertId);
}

/**
 * Carries the native plan snapshots of `fromSetId` onto its successor, as inherited copies. The
 * legacy-backed snapshot is the clone's own business (`cloneConfiguration()` copies the legacy
 * rows and `syncPlanSnapshot()` derives it).
 */
export async function copyNativePlanSnapshots(tx: Tx, gymId: string, fromSetId: number, toSetId: number): Promise<number[]> {
  const { rows } = await tx.query<any>(
    `SELECT id FROM plan_snapshots
      WHERE gym_id = ? AND product_set_id = ? AND source_plan_snapshot_id IS NULL ORDER BY id`, [gymId, fromSetId]);
  const copies: number[] = [];
  for (const row of rows) copies.push(await copyPlanSnapshotToVersion(tx, gymId, Number(row.id), toSetId));
  return copies;
}

/**
 * #2125 stage 13 — "Add": the owner's active version A is merged into the Draft D that carries the
 * plan being added (D is in A's chain, so the schedules and the coverage are already shared).
 * Every plan of A (legacy-backed or native) becomes an inherited native snapshot of D, and A's
 * recurring Product lines and Product Promotions ride along, so activating D supersedes A without
 * losing anything A was billing. D's own plan stays what it is: the one being added.
 */
export async function mergeActiveVersionIntoDraft(tx: Tx, gymId: string, activeSetId: number, draftSetId: number): Promise<void> {
  const { rows: plans } = await tx.query<any>(
    'SELECT id FROM plan_snapshots WHERE gym_id = ? AND product_set_id = ? ORDER BY id', [gymId, activeSetId]);
  for (const plan of plans) await copyPlanSnapshotToVersion(tx, gymId, Number(plan.id), draftSetId);

  await tx.query(
    `INSERT INTO member_products_recurrent_snapshot
       (gym_id, product_set_id, product_id, quantity, starts_at, ends_at, item_name, item_type,
        unit_price, item_billing_frequency, currency, schedule_id, list_unit_price, direct_discount_percent, line_ref, origin, is_inherited)
     SELECT gym_id, ?, product_id, quantity, starts_at, ends_at, item_name, item_type,
            unit_price, item_billing_frequency, currency, schedule_id, list_unit_price, direct_discount_percent, line_ref, origin, 1
       FROM member_products_recurrent_snapshot WHERE gym_id = ? AND product_set_id = ?`,
    [draftSetId, gymId, activeSetId]);
  await copyProductTargetApplications(tx, gymId, activeSetId, draftSetId);
  await syncPlanSnapshot(tx, gymId, draftSetId);
}
