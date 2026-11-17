/**
 * #2951 stage 2 — every exercise has a persistent slug: the Base Exercises (`base_exercises`) and
 * each gym's own exercises (`exercises`, gym_id set).
 *
 * Both tables already have a `slug` column (migration 209, copied by 336): the Free Exercise DB
 * importer writes one for every Base Exercise it creates, and those are kept as they are (a slug is
 * never regenerated). This migration fills the rows that have none:
 *
 *   base_exercises.slug   from `name`, unique within the table (deleted rows included, so a slug is
 *                         never reused; the existing live-only `base_ex_slug_key` stays the backstop)
 *   exercises.slug        per gym: an imported copy takes its Base Exercise's slug (§6), every other
 *                         row its own name; unique within the gym, enforced by
 *                         `exercises_gym_slug_unique (gym_id, slug)`
 *
 * The rule is `api/src/domain/entitySlug.ts`' (a copy, as migration 435 carries one; the unit test
 * keeps them in step): lowercase, accents removed, every run of other characters one hyphen, no
 * leading/trailing hyphen; a taken slug gets `-2`, `-3`, … in id order. No name or other column is
 * written.
 *
 * The columns stay nullable: the Base id reservation inserts a placeholder `exercises` row with no
 * gym (`reserveBaseExerciseId()`), and the writers are gated instead
 * (`exercise-slugs.unit.test.ts`). The migration still refuses to finish while a row has no slug.
 * Safe to re-run: a filled row is never rewritten, except a later row of the same gym holding a slug
 * an earlier one already holds (case-insensitively, as the index compares), which gets its own.
 */

const SLUG_MAX = 120;

function generateSlug(name, fallback) {
  const folded = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function nextAvailableSlug(base, used) {
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

const GYM_KEY = 'exercises_gym_slug_unique';

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, name],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  // 1. Base Exercises: one scope.
  const [base] = await knex.raw('SELECT id, name, slug FROM base_exercises ORDER BY id');
  const usedBase = new Set(base.filter((r) => r.slug).map((r) => r.slug));
  for (const row of base) {
    if (row.slug) continue;
    const slug = nextAvailableSlug(generateSlug(row.name, 'exercise'), usedBase);
    usedBase.add(slug);
    await knex.raw("UPDATE base_exercises SET slug = ? WHERE id = ? AND (slug IS NULL OR slug = '')", [slug, row.id]);
  }
  const [[{ missingBase }]] = await knex.raw(
    "SELECT COUNT(*) AS missingBase FROM base_exercises WHERE slug IS NULL OR slug = ''",
  );
  if (Number(missingBase) > 0) throw new Error(`[437] ${missingBase} base exercise(s) have no slug`);

  // 2. Gym exercises: one scope per gym. Rows that already hold a slug keep it, first come first
  // served in id order; a second row of the same gym holding the same slug is given its own.
  const [rows] = await knex.raw(
    `SELECT e.id, e.gym_id, e.name, e.slug, b.slug AS base_slug
       FROM exercises e
       LEFT JOIN base_exercises b ON b.id = e.base_exercise_id
      WHERE e.gym_id IS NOT NULL
      ORDER BY e.gym_id, e.id`,
  );
  const usedByGym = new Map();
  const usedFor = (gymId) => {
    if (!usedByGym.has(gymId)) usedByGym.set(gymId, new Set());
    return usedByGym.get(gymId);
  };
  const toFill = [];
  for (const row of rows) {
    const used = usedFor(row.gym_id);
    // Keyed lowercase: the UNIQUE index compares under the column's case-insensitive collation.
    if (row.slug && !used.has(row.slug.toLowerCase())) { used.add(row.slug.toLowerCase()); continue; }
    toFill.push(row);
  }
  for (const row of toFill) {
    const used = usedFor(row.gym_id);
    const preferred = row.base_slug || generateSlug(row.name, 'exercise');
    const slug = nextAvailableSlug(preferred.toLowerCase(), used);
    used.add(slug);
    if (row.slug) console.log(`[437] exercise ${row.id} shared slug "${row.slug}" in its gym; now "${slug}"`);
    await knex.raw('UPDATE exercises SET slug = ? WHERE id = ?', [slug, row.id]);
  }
  const [[{ missingGym }]] = await knex.raw(
    "SELECT COUNT(*) AS missingGym FROM exercises WHERE gym_id IS NOT NULL AND (slug IS NULL OR slug = '')",
  );
  if (Number(missingGym) > 0) throw new Error(`[437] ${missingGym} gym exercise(s) have no slug`);

  if (!(await hasIndex(knex, 'exercises', GYM_KEY))) {
    await knex.raw(`ALTER TABLE exercises ADD UNIQUE KEY ${GYM_KEY} (gym_id, slug)`);
  }
};

exports.down = async (knex) => {
  // The slugs written are kept: a slug is never taken back, and the column predates this migration.
  if (await hasIndex(knex, 'exercises', GYM_KEY)) {
    await knex.raw(`ALTER TABLE exercises DROP INDEX ${GYM_KEY}`);
  }
};
