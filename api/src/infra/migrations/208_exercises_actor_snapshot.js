/**
 * #965: the Base Exercise card's header and its Details modal show **Created By**
 * and **Modified By**.
 *
 * `exercises` has carried `created_by` / `modified_by` since migration 096 — both
 * FKs to `gym_memberships` — and the gym-facing router joins them to get a name.
 * That works for a gym's own exercise and can never work for a **Base** one: a
 * base exercise is a `gym_id IS NULL` row administered from Cordel by a
 * superadmin, who has no `gym_memberships` row to point at. `POST
 * /platform/exercises` has therefore never written either column, and there is
 * nothing to join to.
 *
 * So the actor's display name and type are snapshotted at write time, exactly as
 * `tax_rates.created_by_name` (migration 126), `themes.created_by_name` (178) and
 * `nutrition_library_items` (196) already do, for the same reason and with the
 * same CHECK on the `_type` half. The FK columns stay: nothing reads them
 * differently, and the gym router keeps its join as the value for every row
 * written before this migration (`COALESCE(join, snapshot)` in its own SELECT).
 *
 * ── Not backfilled ──────────────────────────────────────────────────────────
 *
 * The obvious source would be `audit_logs`, and for a base exercise there is
 * nothing there to read: `/platform/*` runs behind `requireSuperadmin` alone with
 * no `tenantContext`, so `recordAudit()` returns early without a `req.tenantCtx`
 * and writes no row (migration 196 reasons about the same gap for base foods).
 * A base exercise that existed before this migration therefore reads as the em
 * dash, which is the honest answer; every one written after it carries its own
 * snapshot. Gym-owned exercises need no backfill at all — their creator is the
 * `gym_memberships` row the router already joins.
 *
 * Each statement is guarded independently so a retry after a partial failure
 * (interrupted deploy, lock timeout) resumes rather than silently skipping
 * whatever did not finish.
 */

const TABLE = 'exercises';

/** The two actor pairs, each `<prefix>_by_name` + `<prefix>_by_type`. */
const ACTOR_PREFIXES = ['created', 'modified'];

/** Flattened, so each column is added and dropped under its own guard. */
const ACTOR_COLUMNS = ACTOR_PREFIXES.flatMap((prefix) => [
  { column: `${prefix}_by_name`, length: 255 },
  { column: `${prefix}_by_type`, length: 20 },
]);

async function constraintExists(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = ?`,
    [TABLE, name],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  // Guarded per column, not per pair: knex's mysql2 dialect batches ADDs into one
  // ALTER but emits a separate ALTER per DROP, so a pair-level guard keyed on
  // `_by_name` would skip a half-dropped pair forever and make a later `up()`
  // fail with ER_DUP_FIELDNAME on the surviving column.
  for (const { column, length } of ACTOR_COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, column))) {
      await knex.schema.alterTable(TABLE, (t) => { t.string(column, length).nullable(); });
    }
  }

  // `ADD CONSTRAINT` rebuilds the table under ALGORITHM=COPY, so the two go in
  // one statement rather than two — while still being individually guarded, so a
  // resumed run adds only what is missing.
  const missingChecks = [];
  for (const prefix of ACTOR_PREFIXES) {
    const name = `chk_exercises_${prefix}_by_type`;
    if (!(await constraintExists(knex, name))) {
      missingChecks.push(
        `ADD CONSTRAINT ${name} `
        + `CHECK (${prefix}_by_type IS NULL OR ${prefix}_by_type IN ('staff','superadmin'))`,
      );
    }
  }
  if (missingChecks.length > 0) {
    await knex.raw(`ALTER TABLE ${TABLE} ${missingChecks.join(', ')}`);
  }
};

exports.down = async (knex) => {
  for (const prefix of ACTOR_PREFIXES) {
    const name = `chk_exercises_${prefix}_by_type`;
    if (await constraintExists(knex, name)) {
      await knex.raw(`ALTER TABLE ${TABLE} DROP CHECK ${name}`);
    }
  }
  for (const { column } of [...ACTOR_COLUMNS].reverse()) {
    if (await knex.schema.hasColumn(TABLE, column)) {
      await knex.schema.alterTable(TABLE, (t) => t.dropColumn(column));
    }
  }
};
