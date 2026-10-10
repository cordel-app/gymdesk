/**
 * #1229 — a goal target is **absolute** ("reach 80 kg") or **relative** ("gain
 * 2 kg", "lose 5 kg"), on the catalogue and on the assignment snapshot.
 *
 * `target_type` is `absolute` by default, which is what every target written
 * before this migration means, so no existing assignment changes: only the
 * seeded System goals whose meaning is a *change* (Weight Loss, Weight Gain,
 * Muscle Gain, Maintenance) become relative. A relative target may be negative
 * ("-5 kg"), so `chk_<prefix>_target_value` is widened for relative rows only;
 * an absolute target keeps the non-negative rule.
 *
 * The effective target of a relative goal is derived on read from the
 * assignment's fixed baseline (its first reading), never stored.
 *
 * The CHECK swaps rebuild the two tables under ALGORITHM=COPY; both are small
 * (catalogue + per-member goals) and each statement is guarded, so a re-run is
 * a no-op. `down()` restores the non-negative CHECK and so FAILS if a negative
 * relative target exists — correct them first.
 */
const TABLES = [
  { table: 'personal_goals', prefix: 'pgoal' },
  { table: 'member_personal_goals', prefix: 'mpgoal' },
];

async function hasCheck(knex, name) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?`,
    [name],
  );
  return Number(rows[0].cnt) > 0;
}

exports.up = async (knex) => {
  for (const { table, prefix } of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'target_type'))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN target_type VARCHAR(10) NOT NULL DEFAULT 'absolute'`);
    }
    if (!(await hasCheck(knex, `chk_${prefix}_target_type`))) {
      await knex.raw(
        `ALTER TABLE ${table} ADD CONSTRAINT chk_${prefix}_target_type CHECK (target_type IN ('absolute','relative'))`,
      );
    }
    // One statement, so a failure never leaves the table without the CHECK.
    const drop = (await hasCheck(knex, `chk_${prefix}_target_value`))
      ? `DROP CHECK chk_${prefix}_target_value, ` : '';
    await knex.raw(
      `ALTER TABLE ${table} ${drop}ADD CONSTRAINT chk_${prefix}_target_value
       CHECK (target_value IS NULL OR target_value >= 0 OR target_type = 'relative')`,
    );
  }

  // Seeded System goals: a change, not a final value. Only a row still holding
  // migration 218's seed is touched, so a value Cordel changed is never overwritten.
  const SEEDS = [
    ['weight_loss', -3],
    ['weight_gain', 3],
    ['muscle_gain', 2],
    ['maintenance', 0],
  ];
  for (const [slug, value] of SEEDS) {
    await knex.raw(
      `UPDATE personal_goals SET target_type = 'relative', target_value = ?
       WHERE slug = ? AND gym_id IS NULL AND target_type = 'absolute'
         AND target_unit = 'kg' AND target_value IS NOT NULL AND ABS(target_value) = ABS(?)`,
      [value, slug, value],
    );
  }
};

exports.down = async (knex) => {
  // The seed's own -3 becomes 3 again (the pre-migration value); any other
  // negative target is somebody's data, so refuse before changing anything.
  await knex.raw(
    `UPDATE personal_goals SET target_value = ABS(target_value)
     WHERE slug = 'weight_loss' AND gym_id IS NULL AND target_type = 'relative' AND target_value < 0`,
  );
  for (const { table } of TABLES) {
    const [[neg]] = await knex.raw(`SELECT COUNT(*) AS c FROM ${table} WHERE target_value < 0`);
    if (Number(neg.c) > 0) {
      throw new Error(`negative targets exist in ${table}; correct them before rolling back`);
    }
  }
  for (const { table, prefix } of TABLES) {
    const drop = (await hasCheck(knex, `chk_${prefix}_target_value`))
      ? `DROP CHECK chk_${prefix}_target_value, ` : '';
    await knex.raw(
      `ALTER TABLE ${table} ${drop}ADD CONSTRAINT chk_${prefix}_target_value CHECK (target_value IS NULL OR target_value >= 0)`,
    );
    if (await hasCheck(knex, `chk_${prefix}_target_type`)) {
      await knex.raw(`ALTER TABLE ${table} DROP CHECK chk_${prefix}_target_type`);
    }
    if (await knex.schema.hasColumn(table, 'target_type')) {
      await knex.raw(`ALTER TABLE ${table} DROP COLUMN target_type`);
    }
  }
};
