/**
 * #1325 PR 2b — a ProductSet version can own configuration rows by itself.
 *
 * Migration 246 gave the five assignment-snapshot tables a nullable
 * `product_set_id`; but each still required a `user_membership_id`, and a
 * plan-less set (a locker-only configuration) has no assignment at all. So:
 *
 *   - `user_membership_id` becomes NULLable on the five tables (the legacy FK
 *     and its CASCADE are untouched, so every existing row and reader behaves
 *     exactly as before);
 *   - a ProductSet-keyed row gets its own uniqueness: one line per Product per
 *     version on the three benefit tables, one open service per Product per
 *     version, one standing application of a Promotion per version.
 *
 * The new unique keys are generated/partial on `product_set_id`, so they never
 * constrain a legacy row (NULL never collides). The legacy columns and keys are
 * dropped in PR 3.
 */

const BENEFIT_TABLES = ['user_membership_session', 'user_membership_oneoff', 'user_membership_periodical'];
const ALL = [...BENEFIT_TABLES, 'user_membership_services', 'user_membership_promotions'];

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`, [table, name]);
  return rows.length > 0;
}

exports.up = async (knex) => {
  for (const table of ALL) {
    await knex.raw(`ALTER TABLE ${table} MODIFY user_membership_id INT UNSIGNED NULL`);
  }
  for (const table of BENEFIT_TABLES) {
    const key = `${table}_set_product_unique`;
    if (!(await hasIndex(knex, table, key))) {
      await knex.raw(`ALTER TABLE ${table} ADD UNIQUE KEY ${key} (product_set_id, product_id)`);
    }
  }
  if (!(await knex.schema.hasColumn('user_membership_services', 'open_set_service_key'))) {
    await knex.raw(`ALTER TABLE user_membership_services
      ADD COLUMN open_set_service_key VARCHAR(32) GENERATED ALWAYS AS (
        IF(ends_at IS NULL AND product_set_id IS NOT NULL, CONCAT(product_set_id, ':', product_id), NULL)
      ) VIRTUAL,
      ADD UNIQUE KEY ums_one_open_per_set_item (open_set_service_key)`);
  }
  if (!(await knex.schema.hasColumn('user_membership_promotions', 'standing_set_promotion_key'))) {
    await knex.raw(`ALTER TABLE user_membership_promotions
      ADD COLUMN standing_set_promotion_key VARCHAR(32) GENERATED ALWAYS AS (
        IF(status = 'applied' AND product_set_id IS NOT NULL, CONCAT(product_set_id, ':', promotion_id), NULL)
      ) VIRTUAL,
      ADD UNIQUE KEY ump_one_standing_per_set_promotion (standing_set_promotion_key)`);
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('user_membership_promotions', 'standing_set_promotion_key')) {
    await knex.raw(`ALTER TABLE user_membership_promotions
      DROP INDEX ump_one_standing_per_set_promotion, DROP COLUMN standing_set_promotion_key`);
  }
  if (await knex.schema.hasColumn('user_membership_services', 'open_set_service_key')) {
    await knex.raw(`ALTER TABLE user_membership_services
      DROP INDEX ums_one_open_per_set_item, DROP COLUMN open_set_service_key`);
  }
  for (const table of BENEFIT_TABLES) {
    if (await hasIndex(knex, table, `${table}_set_product_unique`)) {
      await knex.raw(`ALTER TABLE ${table} DROP INDEX ${table}_set_product_unique`);
    }
  }
  // user_membership_id stays NULLable: narrowing it back would fail as soon as a
  // ProductSet-keyed row exists, and a swallowed failure would leave it half-done.
};
