/**
 * #1849 stage F5-2 (Foods) — deletes the legacy System rows of `nutrition_library_items`
 * (`gym_id IS NULL`) and their junction rows. DESTRUCTIVE. Personal Goals' migration 320
 * and Nutrition Goals' 323 one catalogue over.
 *
 * Their Base twins (`base_nutrition_library_items`, same ids) have been the source of
 * Cordel's CRUD (F2), of every gym-side read (F2b) and of the plan references (F4), and
 * migration 333 cleared the legacy references, so this removes dead data. Take a dump
 * first (`docs/go-to-production.md`).
 *
 * The migration refuses, and deletes nothing, unless:
 *   - every legacy System food has a Base twin (otherwise its definition would be lost)
 *     and agrees with it on name, description and whether it is deleted (otherwise an
 *     edit made only on the legacy side would be lost);
 *   - none of the six tables still references a legacy System food (their FKs would
 *     block or null the delete).
 * Afterwards it verifies that no `gym_id IS NULL` row is left and that gym-owned foods,
 * Base foods and the six reference tables kept their counts.
 *
 * `down` is a no-op: restore from the dump.
 */
const REFERENCES = [
  'member_nutrition_plan_meal_items',
  'member_nutrition_plan_restrictions',
  'nutrition_plan_template_meal_items',
  'nutrition_plan_template_restrictions',
  'member_nutrition_plan_goals',
  'nutrition_plan_template_goals',
];

async function count(knex, sql) {
  const [[row]] = await knex.raw(sql);
  return Number(row.n);
}

exports.up = async (knex) => {
  const missing = await count(knex, `
    SELECT COUNT(*) AS n FROM nutrition_library_items i
     WHERE i.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_nutrition_library_items b WHERE b.id = i.id)`);
  if (missing > 0) throw new Error(`#1849 F5-2: ${missing} legacy System food(s) have no base_nutrition_library_items twin; nothing deleted`);

  const diverged = await count(knex, `
    SELECT COUNT(*) AS n FROM nutrition_library_items i JOIN base_nutrition_library_items b ON b.id = i.id
     WHERE i.gym_id IS NULL AND (i.name <> b.name OR NOT (i.description <=> b.description)
        OR (i.status = 'deleted') <> (b.deleted_at IS NOT NULL))`);
  if (diverged > 0) throw new Error(`#1849 F5-2: ${diverged} legacy System food(s) differ from their Base twin; reconcile first, nothing deleted`);

  for (const t of REFERENCES) {
    const refs = await count(knex, `
      SELECT COUNT(*) AS n FROM ${t} x JOIN nutrition_library_items i ON i.id = x.nutrition_library_item_id WHERE i.gym_id IS NULL`);
    if (refs > 0) throw new Error(`#1849 F5-2: ${refs} row(s) of ${t} still reference a legacy System food; nothing deleted`);
  }

  const snapshot = async () => {
    const out = {
      own: await count(knex, 'SELECT COUNT(*) AS n FROM nutrition_library_items WHERE gym_id IS NOT NULL'),
      base: await count(knex, 'SELECT COUNT(*) AS n FROM base_nutrition_library_items'),
    };
    for (const t of REFERENCES) out[t] = await count(knex, `SELECT COUNT(*) AS n FROM ${t}`);
    return out;
  };
  const before = await snapshot();

  for (const junction of [
    'nutrition_library_item_categories', 'nutrition_library_item_qualities',
    'nutrition_library_item_translations', 'nutrition_library_item_description_translations',
  ]) {
    await knex.raw(`DELETE j FROM ${junction} j JOIN nutrition_library_items i ON i.id = j.item_id AND i.gym_id IS NULL`);
  }
  await knex.raw('DELETE FROM nutrition_library_items WHERE gym_id IS NULL');

  const left = await count(knex, 'SELECT COUNT(*) AS n FROM nutrition_library_items WHERE gym_id IS NULL');
  const after = await snapshot();
  if (left !== 0 || JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`#1849 F5-2: post-check failed (left=${left}, before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`);
  }
};

exports.down = async () => {};
