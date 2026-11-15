/**
 * #2834 stage 1 — a Membership Plan's Membership Fee scope.
 *
 *   membership_plans.membership_fee_scope   what a new assignment of the Plan is charged by
 *   plan_snapshots.membership_fee_scope     what this assignment is charged by, frozen at creation
 *
 * `per_family` (one fee per assignment, whatever its beneficiaries) or `per_member` (one fee per
 * beneficiary). NOT NULL DEFAULT 'per_family': adding the column fills every existing plan and
 * snapshot with the value that keeps today's one-fee-per-assignment billing (§5), so there is no
 * separate backfill statement and no row changes what it bills. Vocabulary:
 * `api/src/domain/membershipFeeScope.ts`, mirrored by the two CHECKs below. Both tables are small,
 * so the CHECK's ALGORITHM=COPY rebuild is acceptable.
 *
 * Repeatable (guarded per column and per constraint). `down` drops both.
 */
const hasColumn = async (knex, table) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'membership_fee_scope'`, [table]);
  return rows.length > 0;
};

const hasCheck = async (knex, table, name) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'CHECK'`,
    [table, name]);
  return rows.length > 0;
};

const TARGETS = [
  { table: 'membership_plans', check: 'chk_membership_plans_fee_scope' },
  { table: 'plan_snapshots', check: 'chk_plan_snapshots_fee_scope' },
];

exports.up = async (knex) => {
  for (const { table, check } of TARGETS) {
    const checkSql = `CONSTRAINT ${check} CHECK (membership_fee_scope IN ('per_member', 'per_family'))`;
    if (!(await hasColumn(knex, table))) {
      // One ALTER (one table rebuild) for the column and its CHECK on a first run.
      await knex.raw(
        `ALTER TABLE ${table}
           ADD COLUMN membership_fee_scope VARCHAR(20) NOT NULL DEFAULT 'per_family',
           ADD ${checkSql}`);
      continue;
    }
    if (!(await hasCheck(knex, table, check))) {
      await knex.raw(
        `ALTER TABLE ${table} ADD ${checkSql}`);
    }
  }
};

exports.down = async (knex) => {
  for (const { table, check } of TARGETS) {
    if (await hasCheck(knex, table, check)) await knex.raw(`ALTER TABLE ${table} DROP CHECK ${check}`);
    if (await hasColumn(knex, table)) await knex.raw(`ALTER TABLE ${table} DROP COLUMN membership_fee_scope`);
  }
};
