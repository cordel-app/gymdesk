/**
 * #1325 PR 3e-3 — the commercial columns of `user_memberships` are dropped.
 *
 * An assignment's fee, Billing & Duration, renewal flag, negotiated fee and
 * Personal Membership Fee Benefit are the ProductSet version linked to it
 * (`product_sets.user_membership_id`); since PR 3e-2 every reader takes them
 * from there and the row's copy has been a cache nothing prices from. This
 * migration removes the cache:
 *
 *   `membership_fee_price`, `free_periods`, `paid_periods`, `bonus_periods`,
 *   `pay_beforehand_periods`, `recurring_billing_interval`,
 *   `recurring_billing_unit`, `auto_renew`, `personal_fee_benefit_action`,
 *   `personal_fee_benefit_value`, `discount_reason`, `discount_expires_at`,
 *   `base_price`, `plan_price_id` (with its FK and index).
 *
 * Three things have to be true first, and the migration makes them so:
 *
 *  1. **The Billing frequency has a home.** (The pair is copied onto every
 *     version linked to the assignment — the cadence has been frozen per
 *     assignment, never per version.) A version's cadence lived only on
 *     the chain's schedule, which keeps the cadence of the chain's *first*
 *     version; what an assignment displays and prices a cycle from is the pair
 *     its Plan froze onto it at creation. So the pair becomes two nullable
 *     columns of the version's own plan snapshot (`recurring_billing_interval`,
 *     `recurring_billing_unit`), copied from the row where the row has one — a
 *     NULL pair keeps meaning "follow the Plan's live policy", exactly as
 *     `ASSIGNMENT_CADENCE` always read it.
 *  2. **Every assignment has a version.** A row written before ProductSets (or
 *     by a path that never imported it) is given a **superseded** version that
 *     carries its configuration: the record of what it billed survives the
 *     drop, it holds no one-in-flight or one-active slot, and it generates
 *     nothing. A Draft or Pending Payment row with no version is uncommitted
 *     work that expires under the ProductSet rules anyway: the Draft is
 *     deleted, the pending row closed.
 *  3. **Nothing is dropped over a row that still needs them.** The guard
 *     refuses to run while the version an assignment's configuration will be
 *     read from (its latest linked one) has no plan snapshot.
 *
 * Irreversible, and said here rather than found out: an uncommitted Draft with
 * no version is deleted (with its child rows), a Pending Payment row with none
 * is closed and its pending payment requests expired, and the superseded
 * versions this creates stay on `down()`, which only puts the columns back and
 * refills them from each assignment's latest version. A live (active/paused)
 * assignment with no version becomes a closed record's shape — it has the
 * superseded version but is not projected from an Active one; billing never
 * ran for it after migration 252, so nothing is lost, but it is not editable
 * until a staff action re-commits it.
 *
 * `down()` puts the columns back and fills them from each assignment's latest
 * version; a row's NULL cadence pair stays NULL.
 */

const COLUMNS = [
  'membership_fee_price', 'free_periods', 'paid_periods', 'bonus_periods', 'pay_beforehand_periods',
  'recurring_billing_interval', 'recurring_billing_unit', 'auto_renew',
  'personal_fee_benefit_action', 'personal_fee_benefit_value',
  'discount_reason', 'discount_expires_at', 'base_price', 'plan_price_id',
];

exports.up = async function up(knex) {
  const hasUm = (c) => knex.schema.hasColumn('user_memberships', c);
  if (!(await hasUm('membership_fee_price'))) return; // already dropped

  // 1 — the cadence on the version's own snapshot.
  if (!(await knex.schema.hasColumn('product_set_plan_snapshots', 'recurring_billing_interval'))) {
    await knex.raw(
      `ALTER TABLE product_set_plan_snapshots
         ADD COLUMN recurring_billing_interval INT UNSIGNED NULL AFTER auto_renew,
         ADD COLUMN recurring_billing_unit VARCHAR(10) NULL AFTER recurring_billing_interval`);
  }
  await knex.raw(
    `UPDATE product_set_plan_snapshots snap
       JOIN product_sets ps ON ps.id = snap.product_set_id
       JOIN user_memberships um ON um.id = ps.user_membership_id AND um.gym_id = ps.gym_id
        SET snap.recurring_billing_interval = um.recurring_billing_interval,
            snap.recurring_billing_unit = um.recurring_billing_unit
      WHERE um.recurring_billing_interval IS NOT NULL AND um.recurring_billing_unit IS NOT NULL
        AND snap.recurring_billing_interval IS NULL`);

  // 2 — a version, with a snapshot, for every assignment that has none.
  //
  // An uncommitted Draft with no version expires under the ProductSet rules
  // anyway, so it is deleted (its child rows cascade; `down()` cannot bring it
  // back). A Pending Payment row with no version is closed, and its payment
  // requests still `pending` are expired in the same step so a late webhook has
  // no live request to settle it with.
  await knex.raw(
    `UPDATE payment_requests pr
       JOIN user_memberships um ON um.id = pr.user_membership_id AND um.gym_id = pr.gym_id
        SET pr.status = 'expired'
      WHERE pr.status = 'pending' AND um.status IN ('draft', 'pending_payment')
        AND NOT EXISTS (SELECT 1 FROM product_sets ps WHERE ps.gym_id = um.gym_id AND ps.user_membership_id = um.id)`);
  await knex.raw(
    `DELETE um FROM user_memberships um
      WHERE um.status = 'draft'
        AND NOT EXISTS (SELECT 1 FROM product_sets ps WHERE ps.gym_id = um.gym_id AND ps.user_membership_id = um.id)`);
  await knex.raw(
    `UPDATE user_memberships um
        SET um.status = 'cancelled', um.closed_at = COALESCE(um.closed_at, UTC_TIMESTAMP()),
            um.ends_at = COALESCE(um.ends_at, CURDATE())
      WHERE um.status = 'pending_payment'
        AND NOT EXISTS (SELECT 1 FROM product_sets ps WHERE ps.gym_id = um.gym_id AND ps.user_membership_id = um.id)`);

  // One statement per step, set-based: each is atomic, so a failure between
  // them leaves a state the next run finishes (the snapshot step below also
  // repairs a version left without one).
  await knex.raw(
    `INSERT INTO product_sets
       (gym_id, owner_member_id, version, status, membership_plan_id, starts_at, ends_at,
        user_membership_id, superseded_at, created_by_name, created_by_type)
     SELECT um.gym_id, um.member_id, 1, 'superseded', um.membership_plan_id, um.starts_at, um.ends_at,
            um.id, UTC_TIMESTAMP(), um.created_by_name, um.created_by_type
       FROM user_memberships um
      WHERE NOT EXISTS (SELECT 1 FROM product_sets ps WHERE ps.gym_id = um.gym_id AND ps.user_membership_id = um.id)`);
  await knex.raw(
    `UPDATE product_sets SET root_product_set_id = id
      WHERE root_product_set_id IS NULL AND user_membership_id IS NOT NULL`);
  // The version an assignment's configuration is read from is its latest linked
  // one; if that has no snapshot, write one from the row (this covers the
  // versions just created and any left half-written).
  await knex.raw(
    `INSERT INTO product_set_plan_snapshots
       (gym_id, product_set_id, plan_price_id, base_price, discount_reason, discount_expires_at,
        membership_fee_price, free_periods, paid_periods, bonus_periods, pay_beforehand_periods,
        personal_fee_benefit_action, personal_fee_benefit_value, auto_renew,
        recurring_billing_interval, recurring_billing_unit)
     SELECT um.gym_id, ps.id, um.plan_price_id, um.base_price, um.discount_reason, um.discount_expires_at,
            um.membership_fee_price, um.free_periods, um.paid_periods, um.bonus_periods, um.pay_beforehand_periods,
            COALESCE(um.personal_fee_benefit_action, 'no_benefit'), um.personal_fee_benefit_value,
            COALESCE(um.auto_renew, 0), um.recurring_billing_interval, um.recurring_billing_unit
       FROM user_memberships um
       JOIN product_sets ps ON ps.id = (
              SELECT p9.id FROM product_sets p9
               WHERE p9.gym_id = um.gym_id AND p9.user_membership_id = um.id
               ORDER BY p9.version DESC, p9.id DESC LIMIT 1)
       LEFT JOIN product_set_plan_snapshots s ON s.product_set_id = ps.id
      WHERE s.id IS NULL`);

  // 3 — the guard: the version the readers will pick must have its snapshot.
  const [left] = await knex.raw(
    `SELECT COUNT(*) AS n FROM user_memberships um
       LEFT JOIN product_sets ps ON ps.id = (
              SELECT p9.id FROM product_sets p9
               WHERE p9.gym_id = um.gym_id AND p9.user_membership_id = um.id
               ORDER BY p9.version DESC, p9.id DESC LIMIT 1)
       LEFT JOIN product_set_plan_snapshots s ON s.product_set_id = ps.id
      WHERE s.id IS NULL`);
  if (Number(left[0].n) > 0) {
    throw new Error(
      `Migration 258 refused: ${left[0].n} assignment(s) have no ProductSet version with a plan snapshot.`);
  }

  // The FK and its index go before the column.
  const [fks] = await knex.raw(
    `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_memberships'
        AND COLUMN_NAME = 'plan_price_id' AND REFERENCED_TABLE_NAME IS NOT NULL`);
  for (const fk of fks) {
    await knex.raw(`ALTER TABLE user_memberships DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\``);
  }
  const [idx] = await knex.raw(
    `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_memberships' AND COLUMN_NAME = 'plan_price_id'
        AND INDEX_NAME <> 'PRIMARY'`);
  for (const i of idx) {
    await knex.raw(`ALTER TABLE user_memberships DROP INDEX \`${i.INDEX_NAME}\``);
  }
  const present = [];
  for (const c of COLUMNS) if (await hasUm(c)) present.push(c);
  if (present.length > 0) {
    await knex.raw(`ALTER TABLE user_memberships ${present.map((c) => `DROP COLUMN \`${c}\``).join(', ')}`);
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('user_memberships', 'membership_fee_price')) return;
  await knex.raw(
    `ALTER TABLE user_memberships
       ADD COLUMN base_price DECIMAL(10,2) NULL,
       ADD COLUMN plan_price_id INT UNSIGNED NULL,
       ADD COLUMN discount_reason TEXT NULL,
       ADD COLUMN discount_expires_at DATE NULL,
       ADD COLUMN free_periods INT UNSIGNED NULL,
       ADD COLUMN paid_periods INT UNSIGNED NULL,
       ADD COLUMN bonus_periods INT UNSIGNED NULL,
       ADD COLUMN pay_beforehand_periods INT UNSIGNED NULL,
       ADD COLUMN recurring_billing_interval INT UNSIGNED NULL,
       ADD COLUMN recurring_billing_unit VARCHAR(10) NULL,
       ADD COLUMN membership_fee_price DECIMAL(10,2) NULL,
       ADD COLUMN personal_fee_benefit_action VARCHAR(30) NOT NULL DEFAULT 'no_benefit',
       ADD COLUMN personal_fee_benefit_value DECIMAL(10,2) NULL,
       ADD COLUMN auto_renew TINYINT(1) NOT NULL DEFAULT 0,
       ADD INDEX user_memberships_plan_price_id_foreign (plan_price_id),
       ADD CONSTRAINT user_memberships_plan_price_id_foreign FOREIGN KEY (plan_price_id)
         REFERENCES membership_plan_prices (id) ON DELETE SET NULL`);
  await knex.raw(
    `UPDATE user_memberships um
       JOIN product_sets ps ON ps.gym_id = um.gym_id AND ps.user_membership_id = um.id
        AND ps.version = (SELECT MAX(p2.version) FROM product_sets p2
                           WHERE p2.gym_id = um.gym_id AND p2.user_membership_id = um.id)
       JOIN product_set_plan_snapshots snap ON snap.product_set_id = ps.id
        SET um.base_price = snap.base_price, um.plan_price_id = snap.plan_price_id,
            um.discount_reason = snap.discount_reason, um.discount_expires_at = snap.discount_expires_at,
            um.free_periods = snap.free_periods, um.paid_periods = snap.paid_periods,
            um.bonus_periods = snap.bonus_periods, um.pay_beforehand_periods = snap.pay_beforehand_periods,
            um.recurring_billing_interval = snap.recurring_billing_interval,
            um.recurring_billing_unit = snap.recurring_billing_unit,
            um.membership_fee_price = snap.membership_fee_price,
            um.personal_fee_benefit_action = snap.personal_fee_benefit_action,
            um.personal_fee_benefit_value = snap.personal_fee_benefit_value,
            um.auto_renew = snap.auto_renew`);
};
