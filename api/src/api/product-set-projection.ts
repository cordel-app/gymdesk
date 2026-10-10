import { Tx } from '../infra/db';

/**
 * #1325 PR 3a — the operational assignment an Active ProductSet projects.
 *
 * `user_memberships` is operational only (validity, access, eligibility,
 * coverage) and a ProductSet is the commercial truth. Until every reader of the
 * commercial columns has moved, this is the **one writer** that keeps the
 * assignment row, and the benefit rows keyed to it, in step with the Active
 * version — written when a version activates and never edited by anything else.
 * It is a derived read model, not a second owner:
 *
 *  - `next_billing_date` is left NULL, so the assignment-driven nightly pass
 *    (which selects `next_billing_date IS NOT NULL`) never charges a projected
 *    assignment; the persisted events of the ProductSet are what bill;
 *  - a new version of the **same plan** updates the row in place; a **different
 *    plan** closes the previous assignment and opens a new one (#956's rule, and
 *    what keeps Past Membership Plans meaning "plans the member had");
 *  - a **plan-less** version has no assignment at all, and a previous one is
 *    closed;
 *  - family coverage is copied from `product_set_members`.
 *
 * The projection is removed with the legacy commercial columns in the final
 * stage; nothing may start reading it as the commercial owner.
 */

const BENEFIT_TABLES = ['user_membership_session', 'user_membership_oneoff', 'user_membership_periodical'];

interface SetRow {
  id: number;
  gym_id: string;
  owner_member_id: number;
  root_product_set_id: number;
  previous_product_set_id: number | null;
  membership_plan_id: number | null;
  starts_at: Date | string;
  ends_at: Date | string | null;
  user_membership_id: number | null;
  created_by_name: string | null;
  created_by_type: string | null;
  membership_fee_price: string | number | null;
  free_periods: number | null;
  paid_periods: number | null;
  bonus_periods: number | null;
  pay_beforehand_periods: number | null;
  auto_renew: number | null;
  personal_fee_benefit_action: string | null;
  personal_fee_benefit_value: string | number | null;
  cadence_interval: number | null;
  cadence_unit: string | null;
}

const dateOnly = (v: unknown): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

async function closeAssignment(tx: Tx, gymId: string, id: number, endsAt: string) {
  await tx.query(
    `UPDATE user_memberships
        SET status = 'cancelled', closed_at = UTC_TIMESTAMP(),
            ends_at = LEAST(COALESCE(ends_at, ?), ?)
      WHERE id = ? AND gym_id = ? AND status IN ('active','paused','pending_payment','draft')`,
    [endsAt, endsAt, id, gymId],
  );
}

async function copyBenefitRows(tx: Tx, gymId: string, setId: number, umId: number) {
  for (const table of BENEFIT_TABLES) {
    await tx.query(`DELETE FROM ${table} WHERE gym_id = ? AND user_membership_id = ?`, [gymId, umId]);
    const sessionFrequency = table === 'user_membership_session' ? ', frequency' : '';
    await tx.query(
      `INSERT INTO ${table}
         (gym_id, user_membership_id, product_id, quantity, item_name, item_type, item_billing_frequency,
          unit_price, currency, \`action\`, \`value\`, mandatory${sessionFrequency})
       SELECT gym_id, ?, product_id, quantity, item_name, item_type, item_billing_frequency,
              unit_price, currency, \`action\`, \`value\`, mandatory${sessionFrequency}
         FROM ${table} WHERE gym_id = ? AND product_set_id = ?`,
      [umId, gymId, setId],
    );
  }
}

/** Projects the (just activated) version onto its operational assignment. */
export async function projectActiveProductSet(tx: Tx, gymId: string, productSetId: number): Promise<number | null> {
  const { rows } = await tx.query<SetRow>(
    `SELECT ps.id, ps.gym_id, ps.owner_member_id, ps.root_product_set_id, ps.previous_product_set_id,
            ps.membership_plan_id, ps.starts_at, ps.ends_at, ps.user_membership_id,
            ps.created_by_name, ps.created_by_type,
            snap.membership_fee_price, snap.free_periods, snap.paid_periods, snap.bonus_periods,
            snap.pay_beforehand_periods, snap.auto_renew,
            snap.personal_fee_benefit_action, snap.personal_fee_benefit_value,
            sch.cadence_interval, sch.cadence_unit
       FROM product_sets ps
       LEFT JOIN product_set_plan_snapshots snap ON snap.product_set_id = ps.id
       LEFT JOIN product_set_schedules sch ON sch.id = snap.schedule_id
      WHERE ps.id = ? AND ps.gym_id = ?`,
    [productSetId, gymId],
  );
  const set = rows[0];
  if (!set) return null;

  // The assignment of the version this one replaced, if any.
  let previousUmId: number | null = set.user_membership_id != null ? Number(set.user_membership_id) : null;
  let previousPlanId: number | null = null;
  if (previousUmId == null && set.previous_product_set_id != null) {
    const { rows: prev } = await tx.query<{ user_membership_id: number | null }>(
      'SELECT user_membership_id FROM product_sets WHERE id = ? AND gym_id = ?',
      [set.previous_product_set_id, gymId]);
    previousUmId = prev[0]?.user_membership_id != null ? Number(prev[0].user_membership_id) : null;
  }
  if (previousUmId != null) {
    const { rows: um } = await tx.query<{ membership_plan_id: number | null }>(
      'SELECT membership_plan_id FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE', [previousUmId, gymId]);
    previousPlanId = um[0]?.membership_plan_id != null ? Number(um[0].membership_plan_id) : null;
  }
  const startsAt = dateOnly(set.starts_at) as string;

  // A plan-less version has no assignment; a previous one is closed.
  if (set.membership_plan_id == null) {
    if (previousUmId != null) await closeAssignment(tx, gymId, previousUmId, startsAt);
    await tx.query('UPDATE product_sets SET user_membership_id = NULL WHERE id = ?', [productSetId]);
    return null;
  }

  const columns = [
    set.membership_fee_price ?? null, set.free_periods ?? null, set.paid_periods ?? null,
    set.bonus_periods ?? null, set.pay_beforehand_periods ?? null,
    set.cadence_interval ?? null, set.cadence_unit ?? null,
    set.auto_renew ?? 0,
    set.personal_fee_benefit_action ?? 'no_benefit', set.personal_fee_benefit_value ?? null,
  ];

  let umId: number;
  if (previousUmId != null && previousPlanId === Number(set.membership_plan_id)) {
    // Same plan, new version: the row is updated in place.
    umId = previousUmId;
    await tx.query(
      `UPDATE user_memberships
          SET membership_fee_price = ?, free_periods = ?, paid_periods = ?, bonus_periods = ?,
              pay_beforehand_periods = ?, recurring_billing_interval = ?, recurring_billing_unit = ?,
              auto_renew = ?, personal_fee_benefit_action = ?, personal_fee_benefit_value = ?,
              ends_at = ?, status = IF(status IN ('cancelled','expired'), status, 'active')
        WHERE id = ? AND gym_id = ?`,
      [...columns, dateOnly(set.ends_at), umId, gymId],
    );
  } else {
    if (previousUmId != null) await closeAssignment(tx, gymId, previousUmId, startsAt);
    const { insertId } = await tx.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, starts_at, ends_at, status,
          membership_fee_price, free_periods, paid_periods, bonus_periods, pay_beforehand_periods,
          recurring_billing_interval, recurring_billing_unit, auto_renew,
          personal_fee_benefit_action, personal_fee_benefit_value,
          created_by_name, created_by_type, next_billing_date)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [gymId, set.owner_member_id, set.membership_plan_id, startsAt, dateOnly(set.ends_at), ...columns,
        set.created_by_name, set.created_by_type],
    );
    umId = Number(insertId);
  }

  await copyBenefitRows(tx, gymId, productSetId, umId);

  // Applied Promotions, with the grants each one froze, for the readers that
  // price them from assignment-keyed applications. The version's own rows stay
  // keyed to it; these are re-copied on every projection.
  await tx.query('DELETE FROM user_membership_promotions WHERE gym_id = ? AND user_membership_id = ?', [gymId, umId]);
  const { rows: applications } = await tx.query<any>(
    `SELECT id, promotion_id, applied_by, applied_at, consumed_at, status, snapshot, revoked_at
       FROM user_membership_promotions WHERE gym_id = ? AND product_set_id = ?`,
    [gymId, productSetId],
  );
  for (const app of applications) {
    const { insertId } = await tx.query(
      `INSERT INTO user_membership_promotions
         (gym_id, user_membership_id, promotion_id, applied_by, applied_at, consumed_at, status, snapshot, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gymId, umId, app.promotion_id, app.applied_by, app.applied_at, app.consumed_at, app.status,
        app.snapshot == null ? null : (typeof app.snapshot === 'string' ? app.snapshot : JSON.stringify(app.snapshot)),
        app.revoked_at],
    );
    for (const table of [
      'user_membership_promotion_session_snapshot',
      'user_membership_promotion_oneoff_snapshot',
      'user_membership_promotion_periodical_snapshot',
    ]) {
      await tx.query(
        `INSERT INTO ${table}
           (gym_id, user_membership_promotion_id, product_id, product_name, quantity, item_type,
            item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement)
         SELECT gym_id, ?, product_id, product_name, quantity, item_type,
                item_billing_frequency, unit_price, currency, \`action\`, \`value\`, requirement
           FROM ${table} WHERE gym_id = ? AND user_membership_promotion_id = ?`,
        [insertId, gymId, app.id],
      );
    }
  }

  // Additional recurring services, for the legacy readers that price them from
  // the assignment-keyed rows. The set's own rows stay keyed to the version.
  await tx.query('DELETE FROM user_membership_services WHERE gym_id = ? AND user_membership_id = ?', [gymId, umId]);
  await tx.query(
    `INSERT INTO user_membership_services
       (gym_id, user_membership_id, product_id, quantity, starts_at, ends_at,
        item_name, item_type, unit_price, item_billing_frequency, currency)
     SELECT gym_id, ?, product_id, quantity, starts_at, ends_at,
            item_name, item_type, unit_price, item_billing_frequency, currency
       FROM user_membership_services WHERE gym_id = ? AND product_set_id = ?`,
    [umId, gymId, productSetId],
  );

  // Coverage: the owner and every covered member, from the chain.
  await tx.query('DELETE FROM user_membership_members WHERE gym_id = ? AND user_membership_id = ?', [gymId, umId]);
  await tx.query(
    `INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner)
     SELECT ?, ?, member_id, is_owner FROM product_set_members
      WHERE gym_id = ? AND root_product_set_id = ?`,
    [gymId, umId, gymId, set.root_product_set_id],
  );
  await tx.query(
    `INSERT IGNORE INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner)
     VALUES (?, ?, ?, 1)`,
    [gymId, umId, set.owner_member_id],
  );

  await tx.query('UPDATE product_sets SET user_membership_id = ? WHERE id = ?', [umId, productSetId]);
  return umId;
}
