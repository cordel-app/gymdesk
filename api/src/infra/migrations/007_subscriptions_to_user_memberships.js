/**
 * P1.5 (#9): evolve subscriptions -> user_memberships.
 * Additive columns for plan reference + price snapshotting, tighter status
 * check, and a generated column + unique index that enforces "one active
 * membership per member" (MySQL has no partial unique indexes).
 *
 * Backfill: match old `plan` text to membership_plans.name within the same gym
 * (case-insensitive); copy the plan's base_price into both base_price and
 * final_price. The legacy `plan` text column stays for unmatched rows and is
 * dropped in P1.7.
 */

// MySQL DDL is non-transactional, so this up() is guarded to be re-runnable
// against a partially-applied database (e.g. after a mid-migration failure).
exports.up = async (knex) => {
  if (await knex.schema.hasTable('subscriptions')) {
    await knex.schema.renameTable('subscriptions', 'user_memberships');
  }

  const addColumns = [
    ['membership_plan_id', (t) => t.integer('membership_plan_id').unsigned()
      .references('id').inTable('membership_plans').onDelete('RESTRICT')],
    ['base_price',         (t) => t.decimal('base_price', 10, 2)],
    ['plan_price_id',      (t) => t.integer('plan_price_id').unsigned()
      .references('id').inTable('membership_plan_prices').onDelete('SET NULL')],
    ['final_price',        (t) => t.decimal('final_price', 10, 2)],
    ['discount_reason',    (t) => t.text('discount_reason')],
    ['discount_expires_at',(t) => t.date('discount_expires_at')],
  ];
  for (const [col, add] of addColumns) {
    if (!(await knex.schema.hasColumn('user_memberships', col))) {
      await knex.schema.alterTable('user_memberships', add);
    }
  }

  // Legacy `plan` text column is nullable from now on — new rows carry the FK
  // and leave it NULL; unmatched historical rows keep their string value until
  // P1.7 drops the column entirely.
  await knex.raw("ALTER TABLE user_memberships MODIFY plan VARCHAR(255) NULL");

  // Normalise existing status values before the CHECK is applied.
  await knex.raw("UPDATE user_memberships SET status = 'active' WHERE status NOT IN ('active','paused','cancelled','expired')");
  const [checkRows] = await knex.raw(
    "SELECT 1 FROM information_schema.CHECK_CONSTRAINTS " +
    "WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'user_memberships_status_check'",
  );
  if (checkRows.length === 0) {
    await knex.raw(
      "ALTER TABLE user_memberships ADD CONSTRAINT user_memberships_status_check " +
      "CHECK (status IN ('active','paused','cancelled','expired'))",
    );
  }

  // Backfill FK + prices from matching plan name (case-insensitive, per gym).
  // Idempotent: only touches rows whose FK is still NULL.
  await knex.raw(`
    UPDATE user_memberships um
    JOIN membership_plans p
      ON p.gym_id = um.gym_id AND LOWER(p.name) = LOWER(um.plan)
    SET um.membership_plan_id = p.id,
        um.base_price = p.base_price,
        um.final_price = p.base_price
    WHERE um.membership_plan_id IS NULL
  `);

  // Generated column + unique index enforces the one-active-per-member rule.
  // NULLs don't collide in unique indexes, so non-active rows are exempt.
  //
  // VIRTUAL (not STORED): STORED generated columns whose expression references
  // an FK column (here, member_id → members.id) are rejected by MySQL 8.4 and
  // HeatWave with a misleading "Cannot add foreign key constraint" error —
  // even in a standalone ALTER. VIRTUAL sidesteps this: the column is computed
  // on read, and MySQL 8.0.13+ still supports a UNIQUE secondary index on it
  // (the index is physically materialised, which is what we need).
  if (!(await knex.schema.hasColumn('user_memberships', 'active_member_key'))) {
    await knex.raw(
      "ALTER TABLE user_memberships " +
      "ADD COLUMN active_member_key INT UNSIGNED " +
      "GENERATED ALWAYS AS (IF(status = 'active', member_id, NULL)) VIRTUAL",
    );
  }
  const [indexRows] = await knex.raw(
    "SHOW INDEX FROM user_memberships WHERE Key_name = 'user_memberships_one_active'",
  );
  if (indexRows.length === 0) {
    await knex.raw(
      "ALTER TABLE user_memberships ADD UNIQUE KEY user_memberships_one_active (active_member_key)",
    );
  }
};

exports.down = async (knex) => {
  // Guarded (MySQL DDL is non-transactional).
  await knex.raw('ALTER TABLE user_memberships DROP INDEX user_memberships_one_active').catch(() => {});
  await knex.raw('ALTER TABLE user_memberships DROP COLUMN active_member_key').catch(() => {});
  await knex.raw('ALTER TABLE user_memberships DROP CHECK user_memberships_status_check').catch(() => {});

  for (const col of ['discount_expires_at', 'discount_reason', 'final_price', 'base_price']) {
    if (await knex.schema.hasColumn('user_memberships', col)) {
      await knex.schema.alterTable('user_memberships', (t) => t.dropColumn(col));
    }
  }
  for (const [col, fk] of [
    ['plan_price_id', 'user_memberships_plan_price_id_foreign'],
    ['membership_plan_id', 'user_memberships_membership_plan_id_foreign'],
  ]) {
    if (await knex.schema.hasColumn('user_memberships', col)) {
      await knex.raw(`ALTER TABLE user_memberships DROP FOREIGN KEY \`${fk}\``).catch(() => {});
      await knex.schema.alterTable('user_memberships', (t) => t.dropColumn(col));
    }
  }

  // Restore the NOT NULL constraint on plan (down should mirror up)
  await knex.raw("UPDATE user_memberships SET plan = '' WHERE plan IS NULL").catch(() => {});
  await knex.raw("ALTER TABLE user_memberships MODIFY plan VARCHAR(255) NOT NULL").catch(() => {});

  if (await knex.schema.hasTable('user_memberships')) {
    await knex.schema.renameTable('user_memberships', 'subscriptions');
  }
};
