/**
 * #1849 stage 2f-1 — a System Personal Goal is referenced through
 * `base_personal_goal_id` alone.
 *
 * Until now both columns were set for a System goal (2d/2e): `personal_goal_id`
 * pointed at the legacy System row and `base_personal_goal_id` at its Base twin.
 * This migration makes the reference exclusive:
 *   - `personal_goal_id` becomes NULLable (its `ON DELETE CASCADE` FK to
 *     `personal_goals` stays, for gym-owned goals) and is cleared wherever
 *     `base_personal_goal_id` is set;
 *   - the unique keys follow the goal, whichever column carries it
 *     (`member_personal_goals.live_goal_key`, `gym_personal_goals (gym_id,
 *     catalogue_goal_id)`), swapped *before* the clear so uniqueness is never
 *     suspended;
 *   - `CHECK (exactly one of the two columns)` on both tables.
 *
 * After it nothing references a legacy System row (`personal_goals.gym_id IS
 * NULL`), so the delete of those rows (2f-2, migration 320) can no longer
 * cascade into an assignment or an activation.
 *
 * Guards (the migration refuses, and changes nothing, if any fails):
 *   - a row points at a legacy System goal with no `base_personal_goal_id`;
 *   - a row's two columns disagree (neither expected: both equal ids by 2a/2d);
 * and after the clear it verifies the row counts did not change and no row has
 * both or neither column.
 *
 * Ids of Base and gym-owned goals are disjoint (2b allocated Base ids from the
 * legacy sequence and the platform writer still does), which is what lets the
 * keys use the bare id.
 */
const MEMBER = 'member_personal_goals';
const GYM = 'gym_personal_goals';

async function count(knex, sql) {
  const [[row]] = await knex.raw(sql);
  return Number(row.n);
}

exports.up = async (knex) => {
  for (const t of [MEMBER, GYM]) {
    const unlinked = await count(knex, `
      SELECT COUNT(*) AS n FROM ${t} x JOIN personal_goals p ON p.id = x.personal_goal_id
       WHERE p.gym_id IS NULL AND x.base_personal_goal_id IS NULL`);
    if (unlinked > 0) throw new Error(`#1849 2f: ${unlinked} row(s) of ${t} point at a legacy System goal with no base_personal_goal_id; run the 316/317 backfill`);
    const mismatch = await count(knex, `
      SELECT COUNT(*) AS n FROM ${t} WHERE base_personal_goal_id IS NOT NULL AND personal_goal_id IS NOT NULL
         AND base_personal_goal_id <> personal_goal_id`);
    if (mismatch > 0) throw new Error(`#1849 2f: ${mismatch} row(s) of ${t} have disagreeing goal columns`);
  }
  const before = {
    [MEMBER]: await count(knex, `SELECT COUNT(*) AS n FROM ${MEMBER}`),
    [GYM]: await count(knex, `SELECT COUNT(*) AS n FROM ${GYM}`),
  };

  // 1. personal_goal_id may be NULL (the FK to personal_goals stays for gym-owned goals).
  await knex.raw(`ALTER TABLE ${MEMBER} MODIFY COLUMN personal_goal_id INT UNSIGNED NULL`);
  await knex.raw(`ALTER TABLE ${GYM} MODIFY COLUMN personal_goal_id INT UNSIGNED NULL`);

  // 2. Unique keys follow the goal, whichever column carries it.
  await knex.raw(`ALTER TABLE ${MEMBER} DROP INDEX mpgoal_live_goal_key, DROP COLUMN live_goal_key`);
  await knex.raw(`
    ALTER TABLE ${MEMBER}
      ADD COLUMN live_goal_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
        GENERATED ALWAYS AS (IF(deleted_at IS NULL AND status = 'in_progress',
          CONCAT(member_id, ':', COALESCE(base_personal_goal_id, personal_goal_id)), NULL)) VIRTUAL,
      ADD UNIQUE KEY mpgoal_live_goal_key (live_goal_key)
  `);
  await knex.raw(`
    ALTER TABLE ${GYM}
      ADD COLUMN catalogue_goal_id INT UNSIGNED
        GENERATED ALWAYS AS (COALESCE(base_personal_goal_id, personal_goal_id)) VIRTUAL,
      ADD UNIQUE KEY gpg_gym_catalogue_goal_unique (gym_id, catalogue_goal_id)
  `);
  await knex.raw(`ALTER TABLE ${GYM} DROP INDEX gpg_gym_goal_unique`);

  // 3. Clear the legacy reference of every System-goal row.
  for (const t of [MEMBER, GYM]) {
    await knex.raw(`UPDATE ${t} SET personal_goal_id = NULL WHERE base_personal_goal_id IS NOT NULL`);
  }

  // 4. Exactly one of the two.
  for (const [t, name] of [[MEMBER, 'chk_mpgoal_one_goal_ref'], [GYM, 'chk_gpg_one_goal_ref']]) {
    await knex.raw(`
      ALTER TABLE ${t} ADD CONSTRAINT ${name}
        CHECK ((personal_goal_id IS NULL) <> (base_personal_goal_id IS NULL))
    `);
  }

  for (const t of [MEMBER, GYM]) {
    const after = await count(knex, `SELECT COUNT(*) AS n FROM ${t}`);
    if (after !== before[t]) throw new Error(`#1849 2f: ${t} row count changed (${before[t]} -> ${after})`);
  }
};

exports.down = async () => {};
