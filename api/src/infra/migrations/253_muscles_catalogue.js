/**
 * #1368 stage 1 — the muscle catalogue becomes a table again, with no behaviour
 * change.
 *
 * Migration 052 dropped the per-gym `muscles` table in favour of a static list
 * (`api/src/domain/muscles.ts`) and `exercise_muscles.muscle` slug keys. #1368
 * brings the catalogue back as a **global** lookup (no `gym_id`, like
 * `benefit_types` and `result_types`) administered from Cordel, so a muscle can
 * carry an image pair (stage 3) and an exercise without its own image can fall
 * back to its primary muscle's (stage 4).
 *
 * This stage only creates and fills the table and adds `exercise_muscles
 * .muscle_id`. The old `muscle` column stays, and every reader and writer is
 * untouched, so rollback is safe; stage 2 switches the consumers and a later
 * migration drops `muscle`.
 *
 *  - `slug` is the existing key (UNIQUE); `name` is the English label.
 *  - Seeded with every key of MUSCLE_KEYS (mirrored below, as a migration must
 *    not import application code) and with every key found on a link that the
 *    list does not know (#964 §8 allows these), named from the slug, so no link
 *    is orphaned.
 *  - `muscle_id` is backfilled from the slug. It is nullable here because the
 *    old writers (stage 2 moves them) do not set it yet; stage 2 tightens it.
 *  - Image columns and #799 actor pairs exist from the start so stage 3 needs
 *    no further DDL.
 */

const SEED = [
  ['chest', 'Chest'], ['back', 'Back'], ['shoulders', 'Shoulders'],
  ['biceps', 'Biceps'], ['triceps', 'Triceps'], ['quads', 'Quads'],
  ['hamstrings', 'Hamstrings'], ['glutes', 'Glutes'], ['calves', 'Calves'],
  ['core', 'Core'], ['lats', 'Lats'], ['middle_back', 'Middle Back'],
  ['lower_back', 'Lower Back'], ['traps', 'Traps'], ['forearms', 'Forearms'],
  ['adductors', 'Adductors'], ['abductors', 'Abductors'], ['neck', 'Neck'],
];

const humanize = (slug) =>
  slug.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('muscles'))) {
    await knex.raw(`
      CREATE TABLE muscles (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        slug VARCHAR(60) NOT NULL,
        name VARCHAR(120) NOT NULL,
        image_url VARCHAR(1024) NULL,
        image_thumbnail_url VARCHAR(1024) NULL,
        created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by_name VARCHAR(255) NULL,
        created_by_type VARCHAR(20) NULL,
        modified_at DATETIME NULL,
        modified_by_name VARCHAR(255) NULL,
        modified_by_type VARCHAR(20) NULL,
        CONSTRAINT muscles_slug_unique UNIQUE (slug),
        CONSTRAINT chk_muscles_created_by_type
          CHECK (created_by_type IS NULL OR created_by_type IN ('staff','superadmin')),
        CONSTRAINT chk_muscles_modified_by_type
          CHECK (modified_by_type IS NULL OR modified_by_type IN ('staff','superadmin'))
      )`);
  }

  for (const [slug, name] of SEED) {
    await knex.raw('INSERT IGNORE INTO muscles (slug, name) VALUES (?, ?)', [slug, name]);
  }

  // Keys on existing links that the catalogue does not know: keep them.
  const [unknown] = await knex.raw(
    `SELECT DISTINCT em.muscle AS slug FROM exercise_muscles em
      LEFT JOIN muscles m ON m.slug = em.muscle WHERE m.id IS NULL`,
  );
  for (const { slug } of unknown) {
    console.log(`[253] muscle key "${slug}" on exercise_muscles is not in the catalogue: inserting it as a legacy row`);
    await knex.raw('INSERT IGNORE INTO muscles (slug, name) VALUES (?, ?)', [slug, humanize(slug)]);
  }

  if (!(await knex.schema.hasColumn('exercise_muscles', 'muscle_id'))) {
    await knex.raw('ALTER TABLE exercise_muscles ADD COLUMN muscle_id INT UNSIGNED NULL');
  }
  const [fk] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'exercise_muscles'
        AND CONSTRAINT_NAME = 'exercise_muscles_muscle_fk'`,
  );
  if (fk.length === 0) {
    await knex.raw(
      `ALTER TABLE exercise_muscles ADD CONSTRAINT exercise_muscles_muscle_fk
         FOREIGN KEY (muscle_id) REFERENCES muscles(id) ON DELETE RESTRICT`,
    );
  }
  await knex.raw(
    `UPDATE exercise_muscles em JOIN muscles m ON m.slug = em.muscle
        SET em.muscle_id = m.id WHERE em.muscle_id IS NULL`,
  );
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('exercise_muscles', 'muscle_id')) {
    await knex.raw('ALTER TABLE exercise_muscles DROP FOREIGN KEY exercise_muscles_muscle_fk').catch(() => {});
    await knex.raw('ALTER TABLE exercise_muscles DROP COLUMN muscle_id');
  }
  await knex.schema.dropTableIfExists('muscles');
};
