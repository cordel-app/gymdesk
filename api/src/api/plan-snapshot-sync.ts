/**
 * #2125 stage 2 — dual-write of the plan snapshot model (migration 347) beside the legacy
 * ProductSet rows. Nothing reads `plan_snapshots` yet (stage 3): this module only keeps them
 * equal to what the legacy tables say, in the very transaction that changed the legacy rows.
 *
 * One idempotent function re-derives a version's snapshot from its legacy rows
 * (`product_set_plan_snapshots`, the benefit/periodical tables, the Membership Plan Promotion
 * applications and the chain's coverage), keyed by the `source_*` columns stage 1 added, so the
 * backfill and the dual-write can never disagree about which row is whose. Copying a version
 * (`cloneConfiguration()`) therefore copies the snapshots by re-deriving them, `is_inherited`
 * included, and creates no purchase, application or charge of its own.
 */
import type { Tx } from '../infra/db';
import { syncProductSnapshotsOfVersion } from './product-snapshot-sync';

/** The snapshot status of a version: its own, except where its projected assignment has moved on. */
const STATUS_SQL = `CASE WHEN ps.status = 'active' AND um.status IN ('paused','cancelled','expired') THEN um.status
                         ELSE ps.status END`;

const INCLUDED: Array<{ target: string; source: string; extra: string | null }> = [
  { target: 'plan_session_snapshots', source: 'user_membership_session', extra: 'frequency' },
  { target: 'plan_oneoff_snapshots', source: 'user_membership_oneoff', extra: null },
  { target: 'plan_periodical_snapshots', source: 'user_membership_periodical', extra: 'schedule_id' },
];

const PROMOTION_PRODUCTS: Array<{ target: string; source: string }> = [
  { target: 'plan_promotion_session_product_snapshots', source: 'user_membership_promotion_session_snapshot' },
  { target: 'plan_promotion_oneoff_product_snapshots', source: 'user_membership_promotion_oneoff_snapshot' },
  { target: 'plan_promotion_periodical_product_snapshots', source: 'user_membership_promotion_periodical_snapshot' },
];

/** Re-derives the plan snapshot of one ProductSet version from its legacy rows. */
export async function syncPlanSnapshot(tx: Tx, gymId: string, productSetId: number): Promise<void> {
  // #2126 stage 2: every write that re-derives a version's plan snapshot re-derives its Product lines too.
  await syncProductSnapshotsOfVersion(tx, gymId, productSetId);
  const { rows: legacy } = await tx.query<{ id: number }>(
    `SELECT psps.id
       FROM product_set_plan_snapshots psps
       JOIN product_sets ps ON ps.id = psps.product_set_id AND ps.gym_id = psps.gym_id
      WHERE psps.product_set_id = ? AND psps.gym_id = ? AND ps.membership_plan_id IS NOT NULL`,
    [productSetId, gymId]);

  if (!legacy[0]) {
    // A plan-less version (or one whose plan was removed) has no legacy-backed snapshot; children
    // cascade. A native snapshot (#2125 stage 9: a plan added beside the first, with no legacy row)
    // is not derived from anything here and stays.
    await tx.query('DELETE FROM plan_snapshots WHERE gym_id = ? AND product_set_id = ? AND source_plan_snapshot_id IS NOT NULL',
      [gymId, productSetId]);
    await syncNativeSnapshotStatus(tx, gymId, productSetId);
    return;
  }

  // A version whose configuration row was replaced keeps one snapshot, never two.
  await tx.query('DELETE FROM plan_snapshots WHERE gym_id = ? AND product_set_id = ? AND source_plan_snapshot_id <> ?',
    [gymId, productSetId, legacy[0].id]);
  await syncNativeSnapshotStatus(tx, gymId, productSetId);

  await tx.query(
    `INSERT INTO plan_snapshots
       (gym_id, product_set_id, member_id, membership_plan_id, status, is_inherited, starts_at, ends_at, closed_at,
        schedule_id, plan_price_id, base_price, discount_reason, discount_expires_at, membership_fee_price,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods, personal_fee_benefit_action,
        personal_fee_benefit_value, auto_renew, recurring_billing_interval, recurring_billing_unit, origin,
        source_plan_snapshot_id, source_user_membership_id, created_at, created_by)
     SELECT ps.gym_id, ps.id, ps.owner_member_id, ps.membership_plan_id, ${STATUS_SQL},
            psps.is_inherited, ps.starts_at, ps.ends_at, um.closed_at,
            psps.schedule_id, psps.plan_price_id, psps.base_price, psps.discount_reason, psps.discount_expires_at,
            psps.membership_fee_price, psps.free_periods, psps.paid_periods, psps.bonus_periods,
            psps.pay_beforehand_periods, psps.personal_fee_benefit_action, psps.personal_fee_benefit_value,
            psps.auto_renew, psps.recurring_billing_interval, psps.recurring_billing_unit, psps.origin,
            psps.id, ps.user_membership_id, ps.created_at, ps.created_by
       FROM product_set_plan_snapshots psps
       JOIN product_sets ps ON ps.id = psps.product_set_id AND ps.gym_id = psps.gym_id
       LEFT JOIN user_memberships um ON um.id = ps.user_membership_id AND um.gym_id = ps.gym_id
      WHERE psps.id = ?
     ON DUPLICATE KEY UPDATE
       member_id = VALUES(member_id), membership_plan_id = VALUES(membership_plan_id), status = VALUES(status),
       is_inherited = VALUES(is_inherited), starts_at = VALUES(starts_at), ends_at = VALUES(ends_at),
       closed_at = VALUES(closed_at), schedule_id = VALUES(schedule_id), plan_price_id = VALUES(plan_price_id),
       base_price = VALUES(base_price), discount_reason = VALUES(discount_reason),
       discount_expires_at = VALUES(discount_expires_at), membership_fee_price = VALUES(membership_fee_price),
       free_periods = VALUES(free_periods), paid_periods = VALUES(paid_periods), bonus_periods = VALUES(bonus_periods),
       pay_beforehand_periods = VALUES(pay_beforehand_periods),
       personal_fee_benefit_action = VALUES(personal_fee_benefit_action),
       personal_fee_benefit_value = VALUES(personal_fee_benefit_value), auto_renew = VALUES(auto_renew),
       recurring_billing_interval = VALUES(recurring_billing_interval),
       recurring_billing_unit = VALUES(recurring_billing_unit), origin = VALUES(origin),
       source_user_membership_id = VALUES(source_user_membership_id),
       modified_at = UTC_TIMESTAMP()`,
    [legacy[0].id]);

  const { rows: snap } = await tx.query<{ id: number; member_id: number; root_product_set_id: number }>(
    `SELECT s.id, s.member_id, ps.root_product_set_id
       FROM plan_snapshots s JOIN product_sets ps ON ps.id = s.product_set_id
      WHERE s.source_plan_snapshot_id = ? AND s.gym_id = ?`, [legacy[0].id, gymId]);
  const snapshotId = Number(snap[0].id);

  // Beneficiaries: the owner always, plus whoever the chain covers.
  await tx.query(
    `DELETE FROM plan_snapshot_beneficiaries
      WHERE plan_snapshot_id = ? AND member_id <> ?
        AND member_id NOT IN (SELECT member_id FROM product_set_members WHERE gym_id = ? AND root_product_set_id = ?)`,
    [snapshotId, snap[0].member_id, gymId, snap[0].root_product_set_id]);
  await tx.query(
    `INSERT INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner)
     SELECT ?, ?, ?, 1
     ON DUPLICATE KEY UPDATE is_owner = 1`,
    [gymId, snapshotId, snap[0].member_id]);
  await tx.query(
    `INSERT IGNORE INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner)
     SELECT ?, ?, psm.member_id, 0 FROM product_set_members psm
      WHERE psm.gym_id = ? AND psm.root_product_set_id = ? AND psm.member_id <> ?`,
    [gymId, snapshotId, gymId, snap[0].root_product_set_id, snap[0].member_id]);

  // Included Products: removed legacy rows first (the (snapshot, product) key must be free), then upsert.
  for (const { target, source, extra } of INCLUDED) {
    await tx.query(
      `DELETE FROM ${target}
        WHERE plan_snapshot_id = ?
          AND (source_id IS NULL OR source_id NOT IN (SELECT id FROM ${source} WHERE gym_id = ? AND product_set_id = ?))`,
      [snapshotId, gymId, productSetId]);
    const extraCol = extra ? `, ${extra}` : '';
    const extraSel = extra ? `, u.${extra}` : '';
    const extraUpd = extra ? `, ${extra} = VALUES(${extra})` : '';
    await tx.query(
      `INSERT INTO ${target}
         (gym_id, plan_snapshot_id, source_id, product_id, quantity, item_name, item_type, unit_price,
          item_billing_frequency, currency, \`action\`, \`value\`, mandatory${extraCol}, created_at)
       SELECT u.gym_id, ?, u.id, u.product_id, u.quantity, u.item_name, u.item_type, u.unit_price,
              u.item_billing_frequency, u.currency, u.action, u.value, u.mandatory${extraSel}, u.created_at
         FROM ${source} u WHERE u.gym_id = ? AND u.product_set_id = ?
       ON DUPLICATE KEY UPDATE
         product_id = VALUES(product_id), quantity = VALUES(quantity), item_name = VALUES(item_name),
         item_type = VALUES(item_type), unit_price = VALUES(unit_price),
         item_billing_frequency = VALUES(item_billing_frequency), currency = VALUES(currency),
         \`action\` = VALUES(\`action\`), \`value\` = VALUES(\`value\`), mandatory = VALUES(mandatory)${extraUpd}`,
      [snapshotId, gymId, productSetId]);
  }

  // Membership Plan Promotion applications of this version (Product-target ones are not plan snapshots).
  await tx.query(
    `DELETE FROM plan_promotion_snapshots
      WHERE plan_snapshot_id = ?
        AND (source_id IS NULL OR source_id NOT IN (
              SELECT ump.id FROM user_membership_promotions ump
                JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan'
               WHERE ump.gym_id = ? AND ump.product_set_id = ? AND ump.recurrent_snapshot_id IS NULL))`,
    [snapshotId, gymId, productSetId]);
  await tx.query(
    `INSERT INTO plan_promotion_snapshots
       (gym_id, plan_snapshot_id, source_id, promotion_id, status, is_inherited, snapshot, applied_at, applied_by,
        consumed_at, revoked_at, created_at, created_by, modified_at, modified_by)
     SELECT ump.gym_id, ?, ump.id, ump.promotion_id, ump.status, 0, ump.snapshot, ump.applied_at, ump.applied_by,
            ump.consumed_at, ump.revoked_at, ump.applied_at, ump.created_by, ump.modified_at, ump.modified_by
       FROM user_membership_promotions ump
       JOIN promotions pr ON pr.id = ump.promotion_id AND pr.applies_to = 'membership_plan'
      WHERE ump.gym_id = ? AND ump.product_set_id = ? AND ump.recurrent_snapshot_id IS NULL
     ON DUPLICATE KEY UPDATE
       status = VALUES(status), snapshot = VALUES(snapshot), consumed_at = VALUES(consumed_at),
       revoked_at = VALUES(revoked_at), modified_at = VALUES(modified_at), modified_by = VALUES(modified_by)`,
    [snapshotId, gymId, productSetId]);

  for (const { target, source } of PROMOTION_PRODUCTS) {
    await tx.query(
      `DELETE t FROM ${target} t
         JOIN plan_promotion_snapshots pp ON pp.id = t.plan_promotion_snapshot_id
        WHERE pp.plan_snapshot_id = ?
          AND (t.source_id IS NULL OR t.source_id NOT IN (
                SELECT g.id FROM ${source} g WHERE g.gym_id = ? AND g.user_membership_promotion_id = pp.source_id))`,
      [snapshotId, gymId]);
    await tx.query(
      `INSERT INTO ${target}
         (gym_id, plan_promotion_snapshot_id, source_id, product_id, product_name, quantity, item_type,
          item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement, created_at)
       SELECT g.gym_id, pp.id, g.id, g.product_id, g.product_name, g.quantity, g.item_type,
              g.item_billing_frequency, g.unit_price, g.currency, g.action, g.value, g.requirement, g.created_at
         FROM ${source} g
         JOIN plan_promotion_snapshots pp ON pp.source_id = g.user_membership_promotion_id AND pp.gym_id = g.gym_id
        WHERE pp.plan_snapshot_id = ?
       ON DUPLICATE KEY UPDATE
         product_id = VALUES(product_id), product_name = VALUES(product_name), quantity = VALUES(quantity),
         item_type = VALUES(item_type), item_billing_frequency = VALUES(item_billing_frequency),
         unit_price = VALUES(unit_price), currency = VALUES(currency), \`action\` = VALUES(\`action\`),
         \`value\` = VALUES(\`value\`), requirement = VALUES(requirement)`,
      [snapshotId]);
  }
}

/** Re-derives every version of a chain: coverage follows the chain, so a coverage change touches them all. */
export async function syncPlanSnapshotsOfChain(tx: Tx, gymId: string, rootProductSetId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number }>(
    'SELECT id FROM product_sets WHERE gym_id = ? AND root_product_set_id = ?', [gymId, rootProductSetId]);
  for (const r of rows) await syncPlanSnapshot(tx, gymId, Number(r.id));
}

/** Re-derives the versions linked to an assignment — its status moved (paused, cancelled, expired). */
export async function syncPlanSnapshotsForAssignment(tx: Tx, gymId: string, userMembershipId: number): Promise<void> {
  const { rows } = await tx.query<{ id: number }>(
    'SELECT id FROM product_sets WHERE gym_id = ? AND user_membership_id = ?', [gymId, userMembershipId]);
  for (const r of rows) await syncPlanSnapshot(tx, gymId, Number(r.id));
}

/**
 * #2125 stage 9 — a native snapshot (a plan added beside the first one, `source_plan_snapshot_id`
 * NULL) has no legacy row to be derived from, but it lives and dies with its version: its status
 * follows the version's (draft, pending_payment, active, superseded).
 */
async function syncNativeSnapshotStatus(tx: Tx, gymId: string, productSetId: number): Promise<void> {
  await tx.query(
    `UPDATE plan_snapshots s JOIN product_sets ps ON ps.id = s.product_set_id
        SET s.status = ps.status, s.modified_at = UTC_TIMESTAMP()
      WHERE s.gym_id = ? AND s.product_set_id = ? AND s.source_plan_snapshot_id IS NULL AND s.status <> ps.status`,
    [gymId, productSetId]);
}
