/**
 * #2879 stage 2 — an assignment's own *Members per Membership*.
 *
 *   plan_snapshots.member_limit   how many beneficiaries this assignment covers ('1' | '2' | 'family')
 *
 * Frozen from `membership_plans.member_limit` by the three snapshot writers and copied with the
 * snapshot, so staff may change it while the assignment is a Draft (`PUT /user-memberships/:id/
 * beneficiaries`) without touching the Plan or any other assignment. Nullable: a row is backfilled
 * from its Plan below, and a reader that meets NULL falls back to the Plan's live value
 * (`COALESCE(s.member_limit, mp.member_limit)`), which is exactly what every reader did before.
 * The backfill writes each Plan's *current* limit, not the one it had when the snapshot was taken;
 * that is the value every reader already used, so nothing an existing assignment does changes.
 * Vocabulary: `api/src/domain/planBeneficiaries.ts`, mirrored by the CHECK. The table is small, so
 * the CHECK's ALGORITHM=COPY rebuild is acceptable (migration 422 did the same).
 *
 * Repeatable (guarded per column, per constraint; the backfill only fills NULLs). `down` drops both.
 */
const CHECK = 'chk_plan_snapshots_member_limit';

const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plan_snapshots' AND COLUMN_NAME = 'member_limit'`);
  return rows.length > 0;
};

const hasCheck = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plan_snapshots' AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'CHECK'`,
    [CHECK]);
  return rows.length > 0;
};

exports.up = async (knex) => {
  const checkSql = `CONSTRAINT ${CHECK} CHECK (member_limit IS NULL OR member_limit IN ('1', '2', 'family'))`;
  if (!(await hasColumn(knex))) {
    await knex.raw(`ALTER TABLE plan_snapshots ADD COLUMN member_limit VARCHAR(10) NULL, ADD ${checkSql}`);
  } else if (!(await hasCheck(knex))) {
    await knex.raw(`ALTER TABLE plan_snapshots ADD ${checkSql}`);
  }
  await knex.raw(
    `UPDATE plan_snapshots s JOIN membership_plans mp ON mp.id = s.membership_plan_id
        SET s.member_limit = mp.member_limit
      WHERE s.member_limit IS NULL AND mp.member_limit IN ('1', '2', 'family')`);
};

exports.down = async (knex) => {
  if (await hasCheck(knex)) await knex.raw(`ALTER TABLE plan_snapshots DROP CHECK ${CHECK}`);
  if (await hasColumn(knex)) await knex.raw('ALTER TABLE plan_snapshots DROP COLUMN member_limit');
};
