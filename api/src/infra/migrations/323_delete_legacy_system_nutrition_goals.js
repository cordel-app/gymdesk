/**
 * #1849 stage N4 (Nutrition Goals) — deletes the legacy System rows of
 * `nutrition_goals` (`gym_id IS NULL`) and their `nutrition_goal_translations`.
 * DESTRUCTIVE. Personal Goals' migration 320 one catalogue over.
 *
 * Their Base twins (`base_nutrition_goals`, same ids) have been the source of the
 * Cordel CRUD (N2) and of every gym-side read (N3) and nothing else references a
 * Nutrition Goal by id (the plan routers validate a goal's `item_name` against a
 * closed slug list), so this removes dead data. Take a dump first
 * (`docs/go-to-production.md`).
 *
 * The migration refuses, and deletes nothing, unless every legacy System row has a
 * Base twin (otherwise its definition would be lost) and its slug, name and
 * description agree with the twin's (otherwise an edit made only on the legacy side
 * would be lost). Afterwards it verifies that no `gym_id IS NULL` row is left and
 * that the gym-owned goals and the Base goals kept their counts.
 *
 * `down` is a no-op: restore from the dump.
 */
async function count(knex, sql) {
  const [[row]] = await knex.raw(sql);
  return Number(row.n);
}

exports.up = async (knex) => {
  const missing = await count(knex, `
    SELECT COUNT(*) AS n FROM nutrition_goals g
     WHERE g.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_nutrition_goals b WHERE b.id = g.id)`);
  if (missing > 0) throw new Error(`#1849 N4: ${missing} legacy System goal(s) have no base_nutrition_goals twin; nothing deleted`);

  const diverged = await count(knex, `
    SELECT COUNT(*) AS n FROM nutrition_goals g JOIN base_nutrition_goals b ON b.id = g.id
     WHERE g.gym_id IS NULL AND g.status <> 'deleted' AND b.deleted_at IS NULL
       AND (NOT (g.slug <=> b.slug) OR g.name <> b.name OR NOT (g.description <=> b.description))`);
  if (diverged > 0) throw new Error(`#1849 N4: ${diverged} legacy System goal(s) differ from their Base twin; reconcile first, nothing deleted`);

  const before = {
    own: await count(knex, 'SELECT COUNT(*) AS n FROM nutrition_goals WHERE gym_id IS NOT NULL'),
    base: await count(knex, 'SELECT COUNT(*) AS n FROM base_nutrition_goals'),
    baseTr: await count(knex, 'SELECT COUNT(*) AS n FROM base_nutrition_goal_translations'),
  };

  await knex.raw(`
    DELETE t FROM nutrition_goal_translations t
      JOIN nutrition_goals g ON g.id = t.nutrition_goal_id AND g.gym_id IS NULL`);
  await knex.raw('DELETE FROM nutrition_goals WHERE gym_id IS NULL');

  const left = await count(knex, 'SELECT COUNT(*) AS n FROM nutrition_goals WHERE gym_id IS NULL');
  const after = {
    own: await count(knex, 'SELECT COUNT(*) AS n FROM nutrition_goals WHERE gym_id IS NOT NULL'),
    base: await count(knex, 'SELECT COUNT(*) AS n FROM base_nutrition_goals'),
    baseTr: await count(knex, 'SELECT COUNT(*) AS n FROM base_nutrition_goal_translations'),
  };
  if (left !== 0 || JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`#1849 N4: post-check failed (left=${left}, before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`);
  }
};

exports.down = async () => {};
