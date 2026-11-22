/**
 * #2125 M7a — a plan allowance renewal names its plan session snapshot line, and nothing else.
 *
 * Migration 354 (stage 12) re-keyed `plan_allowance_renewals` to `plan_session_snapshot_id` (FK
 * CASCADE, `UNIQUE par_snapshot_date`) and left `user_membership_session_id` nullable as the frozen
 * record of older rows, with `chk_par_line_ref` keeping at least one of the two set. Nothing has
 * written the legacy column since then, and the table it named (`user_membership_session`) is long
 * gone, so it identifies nothing.
 *
 * This migration drops the legacy column, its `par_line_date` key and the CHECK, and makes
 * `plan_session_snapshot_id` NOT NULL — the CHECK's job, now that there is one column.
 *
 * It refuses while a renewal still has no plan snapshot line (one 354 could not map): such a row
 * grants nothing and no reader shows it, but it is the only record of that renewal, so deleting it is
 * a decision for a person, not for a migration. The error names the rows.
 *
 * Every step is guarded on its own state, so a retry after a partial failure finishes the rest.
 * `down` restores the nullable legacy column, the key and the CHECK; the ids it held are not
 * recoverable, and none is needed (no reader names it).
 */

async function constraintExists(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'plan_allowance_renewals' AND CONSTRAINT_NAME = ?`, [name]);
  return rows.length > 0;
}
async function indexExists(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plan_allowance_renewals' AND INDEX_NAME = ? LIMIT 1`, [name]);
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_allowance_renewals', 'user_membership_session_id'))) return;
  const [orphans] = await knex.raw(
    `SELECT id, gym_id, user_membership_session_id, renewal_date
       FROM plan_allowance_renewals WHERE plan_session_snapshot_id IS NULL ORDER BY id LIMIT 20`);
  if (orphans.length > 0) {
    const [[{ n }]] = await knex.raw(
      'SELECT COUNT(*) AS n FROM plan_allowance_renewals WHERE plan_session_snapshot_id IS NULL');
    throw new Error(
      `migration 459: ${n} renewal(s) with no plan session snapshot line (first ${orphans.length}): `
      + orphans.map((r) => `#${r.id} (gym ${r.gym_id}, legacy line ${r.user_membership_session_id}, ${r.renewal_date})`).join(', ')
      + '. They grant nothing; delete them by hand once confirmed, then re-run.');
  }
  await knex.raw('SET SESSION lock_wait_timeout = 30');
  try {
    if (await constraintExists(knex, 'chk_par_line_ref')) {
      await knex.raw('ALTER TABLE plan_allowance_renewals DROP CHECK chk_par_line_ref');
    }
    if (await indexExists(knex, 'par_line_date')) {
      await knex.raw('ALTER TABLE plan_allowance_renewals DROP KEY par_line_date');
    }
    if (await knex.schema.hasColumn('plan_allowance_renewals', 'user_membership_session_id')) {
      await knex.raw(`ALTER TABLE plan_allowance_renewals
        DROP COLUMN user_membership_session_id,
        MODIFY COLUMN plan_session_snapshot_id INT UNSIGNED NOT NULL`);
    }
  } finally {
    await knex.raw('SET SESSION lock_wait_timeout = DEFAULT');
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('plan_allowance_renewals', 'user_membership_session_id'))) {
    await knex.raw(`ALTER TABLE plan_allowance_renewals
      ADD COLUMN user_membership_session_id INT UNSIGNED NULL AFTER gym_id,
      MODIFY COLUMN plan_session_snapshot_id INT UNSIGNED NULL`);
  }
  if (!(await indexExists(knex, 'par_line_date'))) {
    await knex.raw('ALTER TABLE plan_allowance_renewals ADD UNIQUE KEY par_line_date (user_membership_session_id, renewal_date)');
  }
  if (!(await constraintExists(knex, 'chk_par_line_ref'))) {
    await knex.raw(`ALTER TABLE plan_allowance_renewals ADD CONSTRAINT chk_par_line_ref
      CHECK (user_membership_session_id IS NOT NULL OR plan_session_snapshot_id IS NOT NULL)`);
  }
};
