/**
 * #1849 stage E6 (Exercises) — deletes the legacy System rows of `exercises`
 * (`gym_id IS NULL`) and their junction rows. DESTRUCTIVE. Foods' migration 334 one
 * catalogue over.
 *
 * Their Base twins (`base_exercises`, same ids) have been the source of Cordel's CRUD
 * (E2), of every gym-side read (E2b) and of the plan references (E4), and migration 342
 * cleared the legacy references, so this removes dead data. Take a dump first
 * (`docs/go-to-production.md`).
 *
 * The migration refuses, and deletes nothing, unless:
 *   - every legacy System exercise has a Base twin (otherwise its definition would be
 *     lost) and agrees with it on name, description and whether it is deleted (otherwise
 *     an edit made only on the legacy side would be lost);
 *   - nothing still references a legacy System exercise (the plan tables and
 *     `exercises.cloned_from_id`; their FKs would block or null the delete).
 * Afterwards it verifies that no `gym_id IS NULL` row is left and that gym-owned
 * exercises, Base exercises and the reference tables kept their counts.
 *
 * `down` is a no-op: restore from the dump.
 */
const REFERENCES = [
  ['workout_template_exercises', 'exercise_id'],
  ['workout_exercises', 'exercise_id'],
  ['exercise_logs', 'exercise_id'],
  ['member_standalone_exercises', 'exercise_id'],
  ['exercises', 'cloned_from_id'],
];

async function count(knex, sql) {
  const [[row]] = await knex.raw(sql);
  return Number(row.n);
}

exports.up = async (knex) => {
  const missing = await count(knex, `
    SELECT COUNT(*) AS n FROM exercises e
     WHERE e.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_exercises b WHERE b.id = e.id)`);
  if (missing > 0) throw new Error(`#1849 E6: ${missing} legacy System exercise(s) have no base_exercises twin; nothing deleted`);

  const diverged = await count(knex, `
    SELECT COUNT(*) AS n FROM exercises e JOIN base_exercises b ON b.id = e.id
     WHERE e.gym_id IS NULL AND (e.name <> b.name OR NOT (e.description <=> b.description)
        OR (e.status = 'deleted') <> (b.status = 'deleted'))`);
  if (diverged > 0) throw new Error(`#1849 E6: ${diverged} legacy System exercise(s) differ from their Base twin; reconcile first, nothing deleted`);

  for (const [t, col] of REFERENCES) {
    const refs = await count(knex, `
      SELECT COUNT(*) AS n FROM ${t} x JOIN exercises e ON e.id = x.${col} WHERE e.gym_id IS NULL`);
    if (refs > 0) throw new Error(`#1849 E6: ${refs} row(s) of ${t} still reference a legacy System exercise; nothing deleted`);
  }

  const snapshot = async () => {
    const out = {
      own: await count(knex, 'SELECT COUNT(*) AS n FROM exercises WHERE gym_id IS NOT NULL'),
      base: await count(knex, 'SELECT COUNT(*) AS n FROM base_exercises'),
    };
    // `exercises` itself (the provenance column's table) is counted as `own` above: its total
    // legitimately drops by the legacy System rows.
    for (const [t] of REFERENCES.filter(([name]) => name !== 'exercises')) out[t] = await count(knex, `SELECT COUNT(*) AS n FROM ${t}`);
    return out;
  };
  const before = await snapshot();

  for (const junction of [
    'exercise_translations', 'exercise_description_translations',
    'exercise_muscles', 'exercise_allowed_result_types',
  ]) {
    await knex.raw(`DELETE j FROM ${junction} j JOIN exercises e ON e.id = j.exercise_id AND e.gym_id IS NULL`);
  }
  await knex.raw('DELETE FROM exercises WHERE gym_id IS NULL');

  const left = await count(knex, 'SELECT COUNT(*) AS n FROM exercises WHERE gym_id IS NULL');
  const after = await snapshot();
  if (left !== 0 || JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`#1849 E6: post-check failed (left=${left}, before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`);
  }
};

exports.down = async () => {};
