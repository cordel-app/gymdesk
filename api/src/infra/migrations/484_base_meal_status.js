/**
 * #3328 stage 3 — `base_meals.status`: `active` (offered to a nutrition plan's
 * meal picker) or `inactive` (kept, still read by every meal that already
 * references it, but no longer offered or accepted as a new choice).
 *
 * Every existing meal is `active` through the column default, so nothing
 * changes until Cordel deactivates one. The accepted set is declared in
 * `api/src/domain/baseMeals.ts` (`BASE_MEAL_STATUSES`), mirrored by
 * `chk_base_meals_status` here. `base_meals` holds a handful of rows, so the
 * CHECK's table copy is cheap.
 *
 * Idempotent: the column and the CHECK are each added only when missing.
 */
const hasCheck = (knex) =>
  knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'base_meals'
        AND CONSTRAINT_NAME = 'chk_base_meals_status'`,
  ).then(([rows]) => Number(rows[0].cnt) > 0);

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('base_meals', 'status'))) {
    await knex.raw(
      "ALTER TABLE base_meals ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active' AFTER position",
    );
  }
  if (!(await hasCheck(knex))) {
    await knex.raw(
      "ALTER TABLE base_meals ADD CONSTRAINT chk_base_meals_status CHECK (status IN ('active', 'inactive'))",
    );
  }
};

exports.down = async (knex) => {
  if (await hasCheck(knex)) await knex.raw('ALTER TABLE base_meals DROP CHECK chk_base_meals_status');
  if (await knex.schema.hasColumn('base_meals', 'status')) await knex.raw('ALTER TABLE base_meals DROP COLUMN status');
};
