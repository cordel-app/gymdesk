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
 * One property of the index is worth naming: the table's collation is
 * `utf8mb4_0900_ai_ci`, so the uniqueness is case-insensitive while the
 * importer's own match on `source_id` is exact. Two dataset ids differing only in
 * case would therefore be reported as a failed record (a duplicate-key error on
 * one transaction, the run carrying on — #964 §16) rather than silently merged,
 * which is the right way round. The dataset has no such pair.
 *
 * It deliberately ignores `status`: a Base Exercise an administrator deleted
 * keeps its provenance, so the importer finds it and reports it as skipped
 * rather than silently re-creating what somebody removed. `base_slug_key` does
 * the opposite and excludes deleted rows, exactly as `live_name_key` does
 * elsewhere — a deleted exercise must not keep its slug reserved for ever. One
 * consequence is worth writing down for whoever adds a "restore a deleted Base
 * Exercise" path (nothing restores one today: the platform `PUT` and the recycle
 * bin both exclude these rows): the slug it was deleted with may have been
 * re-issued in the meantime, so such a path has to handle the duplicate key as a
 * 409 rather than assume it can put the row back unchanged. For the same reason
 * `CONCAT(source, ':', source_id)` is only unambiguous while no `source` value
 * contains a colon — true for the one constant there is today.
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

/**
 * Plain nullable columns, in the order they are appended.
 *
 * Exported because the widths are a mirror of `domain/freeExerciseDb.ts`'s
 * clamps (`SOURCE_ID_MAX`, `EXERCISE_SLUG_MAX`, `METADATA_MAX`) — which is what
 * keeps the importer from ever handing MySQL a value it would truncate — and
 * `free-exercise-db.unit.test.ts` asserts the two agree, the way
 * `session-benefit-frequency.unit.test.ts` reads back migration 205's own list.
 */
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
    // `utf8mb4_bin` on purpose: the table's own collation is
    // `utf8mb4_0900_ai_ci`, which would make this uniqueness case- *and*
    // accent-insensitive while the only writer compares `source_id` with strict
    // equality (`matchExistingExercise()`). Two dataset ids differing only in
    // case — the ids are name-derived, so `Pullup` / `PullUp` is plausible —
    // would then have the matcher decide "no match, INSERT" and MySQL answer
    // ER_DUP_ENTRY, costing one of the two exercises its import. A binary
    // collation makes the index agree with the code instead.
    definition:
      "VARCHAR(165) COLLATE utf8mb4_bin GENERATED ALWAYS AS (IF(gym_id IS NULL AND source IS NOT NULL AND source_id IS NOT NULL, CONCAT(source, ':', source_id), NULL)) VIRTUAL",
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

/** The one predicate every base-exercise query shares, importer and list alike. */
const SCAN_INDEX = { name: 'exercises_gym_status_index', columns: '(gym_id, status)' };

exports.up = async (knex) => {
  for (const [column, type] of COLUMNS) {
    if (!(await knex.schema.hasColumn('exercises', column))) {
      await knex.raw(`ALTER TABLE exercises ADD COLUMN \`${column}\` ${type} NULL`);
    }
  }

  for (const { column, definition, index } of KEYS) {
    if (!(await knex.schema.hasColumn('exercises', column))) {
      await knex.raw(`ALTER TABLE exercises ADD COLUMN \`${column}\` ${definition}`);
    }
    if (!(await hasIndex(knex, 'exercises', index))) {
      await knex.raw(`CREATE UNIQUE INDEX ${index} ON exercises (\`${column}\`)`);
    }
  }

  // What the queries this ticket adds actually filter on: `gym_id IS NULL AND
  // status != 'deleted'`, which the importer's own read
  // (`loadExistingBaseExercises()`) and `GET /platform/exercises` both carry. An
  // index led by `source` would be useless for either — the importer never
  // filters on it in SQL, and the column is NULL for every gym row and a single
  // constant for every imported one, so its selectivity is ~zero.
  if (!(await hasIndex(knex, 'exercises', SCAN_INDEX.name))) {
    await knex.raw(`CREATE INDEX ${SCAN_INDEX.name} ON exercises ${SCAN_INDEX.columns}`);
  }
};

exports.down = async (knex) => {
  // Refusal is its own pass, before any drop: MySQL commits DDL implicitly, so a
  // check interleaved with the drops would already have destroyed the provenance
  // by the time it refused.
  //
  // Dropping `source_id` is not reversible by re-running `up()`: the columns come
  // back empty, and `matchExistingExercise()` then falls through to its slug and
  // name passes, *both* of which exclude `status = 'deleted'`. A Base Exercise an
  // administrator deleted would therefore be invisible to the next import run,
  // which would re-create it — the exact thing `base_source_key`'s
  // deleted-rows-included scope exists to prevent (#964 §13) — and a renamed one
  // would be duplicated. Migration 205 refuses for the same reason.
  if (await knex.schema.hasColumn('exercises', 'source_id')) {
    const [rows] = await knex.raw(
      'SELECT COUNT(*) AS cnt FROM exercises WHERE gym_id IS NULL AND source_id IS NOT NULL',
    );
    const stamped = Number(rows[0].cnt);
    if (stamped > 0) {
      throw new Error(
        `[209] ${stamped} Base Exercise(s) carry imported provenance — refusing to drop it. `
        + 'Re-applying this migration reinstates the columns empty, so the next '
        + '`npm run exercises:import-free-db` would no longer recognise an imported Base Exercise '
        + "at all (the slug and name passes both exclude status = 'deleted') and would re-create "
        + 'what an administrator removed. Clear the provenance deliberately first.',
      );
    }
  }

  for (const { column, index } of KEYS) {
    if (await hasIndex(knex, 'exercises', index)) {
      await knex.raw(`DROP INDEX ${index} ON exercises`);
    }
    if (await knex.schema.hasColumn('exercises', column)) {
      await knex.raw(`ALTER TABLE exercises DROP COLUMN \`${column}\``);
    }
  }
  // Guarded rather than `.catch(() => {})`: a swallowed failure here is invisible,
  // because the `DROP COLUMN source` below would then silently *reshape* the index
  // rather than fail, leaving one still named `exercises_gym_status_index` that a
  // later `up()` — which checks the name only — would skip repairing.
  if (await hasIndex(knex, 'exercises', SCAN_INDEX.name)) {
    await knex.raw(`DROP INDEX ${SCAN_INDEX.name} ON exercises`);
  }
  for (const [column] of COLUMNS) {
    if (await knex.schema.hasColumn('exercises', column)) {
      await knex.raw(`ALTER TABLE exercises DROP COLUMN \`${column}\``);
    }
  }
};

/** For the unit test that keeps these widths and the domain's clamps in step. */
exports.COLUMNS = COLUMNS;
exports.KEYS = KEYS;
exports.SCAN_INDEX = SCAN_INDEX;
