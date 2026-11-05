/**
 * #2221 — load the reviewed Spanish and Catalan names of the Base Exercises.
 *
 * The content (`data/base-exercise-names.json`, a frozen copy of `src/data/base-exercise-names.json`,
 * asserted equal by `base-exercise-names.unit.test.ts`) is `{ "<slug>": { "es": "...", "ca": "..." } }`.
 * The owner asked (2026-11-05) for it to load through the deploy pipeline instead of a script run on
 * the VPS, which reverses #1419's "no translation invented by a migration" for these names only;
 * the script `exercises:backfill-names` stays for re-running against newly imported Base Exercises.
 *
 * Only fills what is missing: INSERT IGNORE on (exercise_id, locale), so a name corrected by hand is
 * never overwritten and re-running changes nothing. The English `name` is never written, and a slug
 * with no live Base Exercise is skipped. `down` is a no-op: it cannot tell a loaded name from a
 * corrected one.
 */
const names = require('./data/base-exercise-names.json');

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('base_exercises')) || !(await knex.schema.hasTable('base_exercise_translations'))) return;
  const [rows] = await knex.raw("SELECT id, slug FROM base_exercises WHERE status != 'deleted' AND slug IS NOT NULL");
  const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
  const values = [];
  for (const [slug, byLocale] of Object.entries(names)) {
    const id = idBySlug.get(slug);
    if (!id) continue;
    for (const locale of ['es', 'ca']) {
      const name = typeof byLocale[locale] === 'string' ? byLocale[locale].trim() : '';
      if (name) values.push([id, locale, name]);
    }
  }
  for (let i = 0; i < values.length; i += 500) {
    const chunk = values.slice(i, i + 500);
    await knex.raw(
      `INSERT IGNORE INTO base_exercise_translations (exercise_id, locale, name) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
      chunk.flat(),
    );
  }
};

exports.down = async () => {};
