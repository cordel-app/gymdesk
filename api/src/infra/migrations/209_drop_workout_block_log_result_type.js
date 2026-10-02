/**
 * #1009: drop workout_block_logs.result_type.
 *
 * Migration 042 added it as "a denormalized snapshot of the block's ResultType
 * at logging time". Migration 074 (#154) then moved the result type one level
 * down — it dropped `workout_blocks.result_type` and put `result_type_id` +
 * `target_value`/`min_value`/`max_value`/`unit` on `workout_exercises` — so a
 * block has had no result type of its own for as long as this column has been
 * unfillable: `POST /me/workout-block-logs` still read `wb.result_type` and
 * answered `Unknown column 'wb.result_type' in 'field list'` for every member
 * who marked a block complete.
 *
 * It is dropped rather than re-vocabularied because nothing reads it. Every
 * reader is a blanket projection (`SELECT *` in me.ts's three queries,
 * `SELECT wbl.*` in exercise-logs.ts) and no consumer touches the field: there
 * is no admin caller for `GET /members/:memberId/workout-block-logs`, none for
 * `GET /me/workout-block-logs`, and no report. Keeping it would have meant
 * inventing what a block-level result type means when its exercises disagree,
 * and backfilling the rows holding `Rounds`/`Score` — which have no equivalent
 * in the `result_types` slug vocabulary — with that invention.
 *
 * `result_value` stays. It is varchar(60) free text the member types for the
 * block ("21:04", "7 rounds + 3"); what it loses is a column claiming to
 * interpret it. Typed, per-set results are the exercise instance's, in
 * `exercise_logs` + `exercise_log_sets`.
 */
/** True when `wbl_result_type_check` exists in the current schema. */
const hasResultTypeCheck = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS n FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'wbl_result_type_check'`,
  );
  return rows[0].n > 0;
};

exports.up = async (knex) => {
  // The CHECK goes first. MySQL 8 would drop a single-column CHECK along with
  // its column anyway, so this is explicitness rather than necessity — it
  // matches 071's and 074's precedent and keeps the statement portable. The
  // errno guard is `ER_CHECK_CONSTRAINT_NOT_FOUND`, for a database whose rows
  // predate 042's CHECK: a lock-wait or metadata-lock timeout still throws
  // rather than passing silently.
  if (await hasResultTypeCheck(knex)) {
    await knex.raw('ALTER TABLE workout_block_logs DROP CHECK wbl_result_type_check')
      .catch((err) => { if (err?.errno !== 3940) throw err; });
  }
  // DROP COLUMN here is accepted under ALGORITHM=INSTANT — metadata only, no
  // table rebuild — so this direction carries no large-table cost. `result_type`
  // is in no index and no FK, so it takes nothing with it but that CHECK.
  if (await knex.schema.hasColumn('workout_block_logs', 'result_type')) {
    await knex.schema.alterTable('workout_block_logs', (t) => {
      t.dropColumn('result_type');
    });
  }
};

exports.down = async (knex) => {
  // The DEFAULT is load-bearing, not a convenience: `me.ts`'s INSERT no longer
  // names the column, so without one a rollback would re-break
  // `POST /me/workout-block-logs` as ER_NO_DEFAULT_FOR_FIELD under strict mode.
  // 'None' is migration 042's own "no result" member of the vocabulary, so the
  // default and the restored CHECK agree. Migration 074's `down` restores the
  // block columns it dropped the same way.
  if (!(await knex.schema.hasColumn('workout_block_logs', 'result_type'))) {
    await knex.schema.alterTable('workout_block_logs', (t) => {
      t.string('result_type', 20).notNullable().defaultTo('None').after('finished_at');
    });
  }
  // Guarded on the constraint's own existence, not the column's: these are two
  // statements and the second can fail alone, so keying both on `hasColumn`
  // would make a re-run of a half-finished `down` a silent no-op that never
  // re-added the CHECK. `ADD CONSTRAINT ... CHECK` accepts neither INSTANT nor
  // INPLACE, so this rollback rebuilds the table under ALGORITHM=COPY — the
  // `up` above does not. The legacy name is spelled as 042 created it rather
  // than as `chk_<table>_<column>`: `DROP CHECK` above must find it, so a
  // convention sweep that renamed it would break the up/down pair.
  if (!(await hasResultTypeCheck(knex))) {
    await knex.raw(
      'ALTER TABLE workout_block_logs ADD CONSTRAINT wbl_result_type_check CHECK ' +
      "(result_type IN ('None','Time','Rounds','Repetitions','Distance','Calories','Weight','Score'))",
    );
  }
};
