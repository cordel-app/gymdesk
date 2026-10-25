/**
 * #1849 stage E5 (Exercises) — a System Exercise is referenced through
 * `base_exercise_id` alone. Foods' migration 333 one catalogue over.
 *
 * Until now both columns were set for a System exercise (E3/E4): `exercise_id`
 * (`cloned_from_id`) pointed at the legacy System row and `base_exercise_id` at its Base
 * twin. This makes the reference exclusive on the five places that carry one:
 *   - `exercise_id` becomes NULLable on the four tables where it was NOT NULL and is
 *     cleared wherever `base_exercise_id` is set (its FK to `exercises` stays, for gym-owned
 *     exercises); `exercises.cloned_from_id` is cleared wherever `base_exercise_id` is set;
 *   - CHECK: exactly one of the two on the four tables whose reference is mandatory
 *     (`workout_template_exercises`, `workout_exercises`, `exercise_logs`,
 *     `member_standalone_exercises`). `exercises` (provenance, optional, SET NULL FKs) cannot
 *     carry a CHECK over those columns (MySQL error 3823): "at most one" is the writers' and
 *     `npm run exercises:audit-base-links`';
 *   - `member_standalone_exercises` gets a second UNIQUE key on the Base column: its
 *     existing key follows `exercise_id`, which is NULL for a System exercise now (NULLs
 *     are distinct, so it would no longer stop a duplicate addition).
 *
 * The `exercise_catalogue` view (migration 338) keeps reporting a gym copy's provenance as
 * `cloned_from_id`, now `COALESCE(base_exercise_id, cloned_from_id)`, so the wire contract
 * (the Exercises list's System sourced / Custom badge) does not move.
 *
 * After it nothing references a legacy System exercise through an FK, so deleting those
 * rows (migration 343) can no longer hit a RESTRICT or null a provenance.
 *
 * Guards (the migration refuses, and changes nothing, if any fails): a row points at a
 * legacy System exercise with no Base reference, or the two columns disagree. After the
 * clear it verifies the row counts did not change.
 */
const MANDATORY = [
  ['workout_template_exercises', 'chk_wte_one_exercise_ref'],
  ['workout_exercises', 'chk_we_one_exercise_ref'],
  ['exercise_logs', 'chk_el_one_exercise_ref'],
  ['member_standalone_exercises', 'chk_mse_one_exercise_ref'],
];
// table -> old column
const ALL = [...MANDATORY.map(([t]) => [t, 'exercise_id']), ['exercises', 'cloned_from_id']];

async function count(knex, sql) {
  const [[row]] = await knex.raw(sql);
  return Number(row.n);
}

exports.up = async (knex) => {
  const before = {};
  for (const [t, col] of ALL) {
    const unlinked = await count(knex, `
      SELECT COUNT(*) AS n FROM ${t} x JOIN exercises e ON e.id = x.${col}
       WHERE e.gym_id IS NULL AND x.base_exercise_id IS NULL`);
    if (unlinked > 0) throw new Error(`#1849 E5: ${unlinked} row(s) of ${t} point at a legacy System exercise with no base_exercise_id; run migration 340's backfill`);
    const mismatch = await count(knex, `
      SELECT COUNT(*) AS n FROM ${t} WHERE base_exercise_id IS NOT NULL
         AND ${col} IS NOT NULL AND base_exercise_id <> ${col}`);
    if (mismatch > 0) throw new Error(`#1849 E5: ${mismatch} row(s) of ${t} have disagreeing exercise columns`);
    before[t] = await count(knex, `SELECT COUNT(*) AS n FROM ${t}`);
  }

  for (const [t] of MANDATORY) {
    await knex.raw(`ALTER TABLE ${t} MODIFY COLUMN exercise_id INT UNSIGNED NULL`);
  }
  for (const [t, col] of ALL) {
    await knex.raw(`UPDATE ${t} SET ${col} = NULL WHERE base_exercise_id IS NOT NULL`);
  }
  for (const [t, name] of MANDATORY) {
    await knex.raw(`ALTER TABLE ${t} ADD CONSTRAINT ${name}
      CHECK ((exercise_id IS NULL) <> (base_exercise_id IS NULL))`);
  }
  await knex.raw(`ALTER TABLE member_standalone_exercises
    ADD UNIQUE KEY member_standalone_base_unique (member_id, base_exercise_id, exercise_date)`);

  const COLUMNS = `name, description, short_description, status, min_reps_default, max_reps_default,
  rest_default_seconds, sets_default, source, source_id, slug, equipment, category, level, mechanic,
  force_type, image_male_url, image_female_url, video_male_url, video_female_url,
  created_at, created_by, modified_at, modified_by, deleted_at, deleted_by`;
  await knex.raw(`
    CREATE OR REPLACE VIEW exercise_catalogue AS
    SELECT id, NULL AS gym_id, NULL AS cloned_from_id, ${COLUMNS} FROM base_exercises
    UNION ALL
    SELECT id, gym_id, COALESCE(base_exercise_id, cloned_from_id) AS cloned_from_id, ${COLUMNS}
      FROM exercises WHERE gym_id IS NOT NULL
  `);

  for (const [t] of ALL) {
    const after = await count(knex, `SELECT COUNT(*) AS n FROM ${t}`);
    if (after !== before[t]) throw new Error(`#1849 E5: ${t} row count changed (${before[t]} -> ${after})`);
  }
};

exports.down = async () => {};
