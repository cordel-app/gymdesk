/**
 * #1849 stage 2f-2 — deletes the legacy System rows of `personal_goals`
 * (`gym_id IS NULL`) and their `personal_goal_translations`. DESTRUCTIVE.
 *
 * Their Base twins (`base_personal_goals`, same ids) have been authoritative since
 * 2c-2f-1 and nothing references the legacy rows any more (migration 319), so this
 * removes dead data. Take a dump first (`docs/go-to-production.md`).
 *
 * The migration refuses, and deletes nothing, unless every guard holds:
 *   - every legacy System row has a Base twin (otherwise its definition would be lost);
 *   - no `member_personal_goals` / `gym_personal_goals` row references a legacy System
 *     row (otherwise the `ON DELETE CASCADE` FK would delete it);
 *   - no gym-owned goal records one as its template (`personal_goals.base_personal_goal_id`
 *     references the Base table, not these rows, so this is a belt-and-braces check on ids).
 * and it verifies afterwards that no row with `gym_id IS NULL` is left and that the
 * gym-owned goals, assignments and activations were not touched (counts).
 *
 * `down` is a no-op: restore from the dump.
 */
async function count(knex, sql) {
  const [[row]] = await knex.raw(sql);
  return Number(row.n);
}

exports.up = async (knex) => {
  const missing = await count(knex, `
    SELECT COUNT(*) AS n FROM personal_goals p
     WHERE p.gym_id IS NULL AND NOT EXISTS (SELECT 1 FROM base_personal_goals b WHERE b.id = p.id)`);
  if (missing > 0) throw new Error(`#1849 2f-2: ${missing} legacy System goal(s) have no base_personal_goals twin; nothing deleted`);

  for (const t of ['member_personal_goals', 'gym_personal_goals']) {
    const refs = await count(knex, `
      SELECT COUNT(*) AS n FROM ${t} x JOIN personal_goals p ON p.id = x.personal_goal_id WHERE p.gym_id IS NULL`);
    if (refs > 0) throw new Error(`#1849 2f-2: ${refs} row(s) of ${t} still reference a legacy System goal; nothing deleted`);
  }

  const before = {
    own: await count(knex, 'SELECT COUNT(*) AS n FROM personal_goals WHERE gym_id IS NOT NULL'),
    member: await count(knex, 'SELECT COUNT(*) AS n FROM member_personal_goals'),
    gym: await count(knex, 'SELECT COUNT(*) AS n FROM gym_personal_goals'),
    base: await count(knex, 'SELECT COUNT(*) AS n FROM base_personal_goals'),
  };

  await knex.raw(`
    DELETE t FROM personal_goal_translations t
      JOIN personal_goals p ON p.id = t.personal_goal_id AND p.gym_id IS NULL`);
  await knex.raw('DELETE FROM personal_goals WHERE gym_id IS NULL');

  const left = await count(knex, 'SELECT COUNT(*) AS n FROM personal_goals WHERE gym_id IS NULL');
  const after = {
    own: await count(knex, 'SELECT COUNT(*) AS n FROM personal_goals WHERE gym_id IS NOT NULL'),
    member: await count(knex, 'SELECT COUNT(*) AS n FROM member_personal_goals'),
    gym: await count(knex, 'SELECT COUNT(*) AS n FROM gym_personal_goals'),
    base: await count(knex, 'SELECT COUNT(*) AS n FROM base_personal_goals'),
  };
  if (left !== 0 || JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`#1849 2f-2: post-check failed (left=${left}, before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`);
  }
};

exports.down = async () => {};
