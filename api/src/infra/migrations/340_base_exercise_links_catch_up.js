/**
 * #1849 stage E4 (Exercises) — re-runs migration 339's idempotent backfill for the rows
 * written between that migration and the deploy of the writers that now set
 * `base_exercise_id` themselves (workout and plan writers and copies, exercise logs,
 * standalone additions, the import/clone flow). A row pointing at a System exercise gets
 * the Base reference (the ids are equal); a row of a gym-owned exercise is left alone.
 */
const TABLES = [
  { table: 'workout_template_exercises', from: 'exercise_id' },
  { table: 'workout_exercises', from: 'exercise_id' },
  { table: 'exercise_logs', from: 'exercise_id' },
  { table: 'member_standalone_exercises', from: 'exercise_id' },
  { table: 'exercises', from: 'cloned_from_id' },
];

exports.up = async (knex) => {
  for (const { table, from } of TABLES) {
    await knex.raw(`
      UPDATE ${table} t
        JOIN exercises x ON x.id = t.${from} AND x.gym_id IS NULL
         SET t.base_exercise_id = x.id
       WHERE t.base_exercise_id IS NULL
    `);
  }
};

exports.down = async () => {};
