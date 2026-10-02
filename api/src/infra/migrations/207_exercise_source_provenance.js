/**
 * #964 — Base Exercises gain the provenance and the source metadata the Free
 * Exercise DB import needs.
 *
 * ── What this migration is for ──────────────────────────────────────────────
 *
 * The importer (`api/src/scripts/import-free-exercise-db.ts`) must be
 * **repeatable and idempotent** (§2): running it twice may not create a second
 * copy of an exercise. Matching on the display name alone is what §3 forbids, so
 * every imported row carries the dataset's own identifier and the catalogue it
 * came from:
 *
 *   source     = 'free-exercise-db'
 *   source_id  = the dataset's `id` (e.g. `Alternate_Incline_Dumbbell_Curl`)
 *
 * `slug` is the application's own stable handle for the exercise, generated from
 * the name the way §5's example spells it (`alternate-incline-dumbbell-curl`) and
 * then never regenerated — a row keeps the slug it was created with even if an
 * administrator renames it, which is what "existing valid slugs should not
 * unnecessarily change" means.
 *
 * The five source metadata columns are §6: the dataset's `force`, `level`,
 * `mechanic`, `equipment` and `category`, stored **verbatim** rather than
 * coerced into a taxonomy this product does not have. The ticket's closing rule
 * is explicit about the preference — *preserve the source data → use the
 * existing application model → report the ambiguity* — and §18 asks that the
 * catalogue be filterable by Equipment "if supported by the current UI/model",
 * which it now is at the API level. `force` is a reserved word in MySQL 8
 * (`FORCE INDEX`), so the column is `force_type`; nothing else is renamed.
 *
 * Note what is **not** here: no image or media column (§10 — the import stores no
 * image at all, and `exercises` already carries the four media columns of
 * migrations 187/188 for the uploads an administrator makes), no second exercise
 * catalogue (§11), and no new taxonomy table (§7 — "do not invent a new type").
 *
 * ── Why the uniqueness is a generated column ────────────────────────────────
 *
 * `exercises` holds both the platform's Base Exercises (`gym_id IS NULL`) and
 * every gym's own copies, and a plain `UNIQUE (source, source_id)` would be
 * wrong twice over: MySQL does not treat two NULLs as equal, so it would not
 * constrain the base rows it is meant to (their `gym_id` is NULL, but that is not
 * the indexed column — the real problem is the second one), and it would reach
 * into the gyms' copies, where a future ticket may well want provenance too.
 * `base_source_key` is migration 183's device — a VIRTUAL generated column that
 * is non-NULL only for a base row carrying provenance, with the UNIQUE index on
 * it — so "one Base Exercise per source id" is enforced by construction and a
 * gym's copy is outside the constraint. VIRTUAL rather than STORED because MySQL
 * rejects a STORED generated column over a foreign-key column (`gym_id`).
 *
 * It deliberately ignores `status`: a Base Exercise an administrator deleted
 * keeps its provenance, so the importer finds it and reports it as skipped
 * rather than silently re-creating what somebody removed. `base_slug_key` does
 * the opposite and excludes deleted rows, exactly as `live_name_key` does
 * elsewhere — a deleted exercise must not keep its slug reserved for ever.
 *
 * ── No CHECK on `source` ────────────────────────────────────────────────────
 *
 * The CHECK-mirrors-a-declaration rule exists for closed vocabularies a router
 * writes from a request body. Nothing in the API writes these columns: the
 * importer is the only writer, `FREE_EXERCISE_DB_SOURCE` is declared once in
 * `api/src/domain/freeExerciseDb.ts`, and `ADD CONSTRAINT` on `exercises` would
 * rebuild the table under `ALGORITHM=COPY` for a constraint buying nothing.
 *
 * Every statement is guarded on its own: MySQL commits DDL implicitly, so a
 * crash between two of them must not make a re-run skip one (migrations
 * 134/140/155/183/205/206).
 */

/** Plain nullable columns, in the order they are appended. */
const COLUMNS = [
  ['source', 'VARCHAR(40)'],
  ['source_id', 'VARCHAR(120)'],
  ['slug', 'VARCHAR(220)'],
  ['equipment', 'VARCHAR(60)'],
  ['category', 'VARCHAR(60)'],
  ['level', 'VARCHAR(30)'],
  ['mechanic', 'VARCHAR(30)'],
  ['force_type', 'VARCHAR(30)'],
];

/** The two generated columns and the UNIQUE index each one carries. */
const KEYS = [
  {
    column: 'base_source_key',
    definition:
      "VARCHAR(165) GENERATED ALWAYS AS (IF(gym_id IS NULL AND source IS NOT NULL AND source_id IS NOT NULL, CONCAT(source, ':', source_id), NULL)) VIRTUAL",
    index: 'exercises_base_source_key',
  },
  {
    column: 'base_slug_key',
    definition:
      "VARCHAR(220) GENERATED ALWAYS AS (IF(gym_id IS NULL AND status <> 'deleted' AND slug IS NOT NULL, slug, NULL)) VIRTUAL",
    index: 'exercises_base_slug_key',
  },
];

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, name],
  );
  return Number(rows[0].cnt) > 0;
}

exports.up = async (knex) => {
  for (const [column, type] of COLUMNS) {
    if (!(await knex.schema.hasColumn('exercises', column))) {
      await knex.raw(`ALTER TABLE exercises ADD COLUMN ${column} ${type} NULL`);
    }
  }

  for (const { column, definition, index } of KEYS) {
    if (!(await knex.schema.hasColumn('exercises', column))) {
      await knex.raw(`ALTER TABLE exercises ADD COLUMN ${column} ${definition}`);
    }
    if (!(await hasIndex(knex, 'exercises', index))) {
      await knex.raw(`CREATE UNIQUE INDEX ${index} ON exercises (${column})`);
    }
  }

  // The importer's own lookups: "which base rows carry this source?" and the
  // Base Exercises list's new Equipment / Category filters (§18).
  if (!(await hasIndex(knex, 'exercises', 'exercises_source_index'))) {
    await knex.raw('CREATE INDEX exercises_source_index ON exercises (source, status)');
  }
};

exports.down = async (knex) => {
  for (const { column, index } of KEYS) {
    await knex.raw(`DROP INDEX ${index} ON exercises`).catch(() => {});
    if (await knex.schema.hasColumn('exercises', column)) {
      await knex.raw(`ALTER TABLE exercises DROP COLUMN ${column}`);
    }
  }
  await knex.raw('DROP INDEX exercises_source_index ON exercises').catch(() => {});
  for (const [column] of COLUMNS) {
    if (await knex.schema.hasColumn('exercises', column)) {
      await knex.raw(`ALTER TABLE exercises DROP COLUMN ${column}`);
    }
  }
};
