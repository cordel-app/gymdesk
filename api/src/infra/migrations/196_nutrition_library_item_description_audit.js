/**
 * #799: Nutrition Library — read-only expanded row, Details modal, separate Edit.
 *
 * The ticket needs two things the row cannot answer today:
 *
 *  1. **A description.** `nutrition_library_items` has never had one — the row is
 *     `id, gym_id, name, status, image_url, created_at, modified_at` (+ the
 *     junction tables) — and §12 asks for it to be added across the domain rather
 *     than rendered as a UI-only field. Nullable, VARCHAR(1000) — the same
 *     immutable-snapshot-free plain column `tax_rates.description` (migration 126)
 *     is, at the width `DESCRIPTION_MAX_LENGTH` in
 *     `api/src/domain/nutritionLibrary.ts` declares (126's own is 500; do not read
 *     either as a house width).
 *
 *  2. **Who created / modified / deleted the item.** §9 and §13 ask the Details
 *     modal to show Created At / By, Modified At / By and Deleted At / By, using
 *     the pattern the other Details modals already follow. There is no actor
 *     column to join on, and for the Base library there never can be one: a base
 *     food is a `gym_id IS NULL` row written by a superadmin, who has no
 *     `gym_memberships` row to point at. So snapshot the actor's display name and
 *     type at write time — the immutable-snapshot shape `tax_rates.created_by_name`
 *     (126) and `themes.created_by_name` (178) already use.
 *
 * `deleted_at` is added beside them. The library's soft delete is
 * `status = 'deleted'` and that stays the flag every query filters on: this column
 * records *when*, which `status` cannot, and nothing reads it as "is it deleted".
 *
 * ── Backfill ────────────────────────────────────────────────────────────────
 *
 * `deleted_at` is derived from `modified_at` for rows already deleted, which is
 * exact rather than a guess: `DELETE /platform/nutrition-library/:id` is the only
 * statement in the codebase that sets `status = 'deleted'`, it sets
 * `modified_at = UTC_TIMESTAMP()` in the same UPDATE, and every other writer
 * (`PUT /:id`, the qualities/categories/translations sub-resources, the image
 * upload) answers 409 for an item that is already deleted — so no later write can
 * have moved `modified_at` past the deletion. Scoped to `deleted_at IS NULL` so it
 * is safe to re-run and never overwrites a value the application wrote. A deleted
 * row whose `modified_at` is somehow NULL is left alone rather than given an
 * invented date: the em dash the Details modal renders is the honest answer, and
 * only direct SQL (the test suite does it) can produce that state.
 *
 * The actor columns are **not** backfilled. The obvious source would be
 * `audit_logs`, but the platform router's `recordAudit()` calls are no-ops:
 * `/platform/*` runs behind `requireSuperadmin` alone (no `tenantContext`), and
 * `recordAudit()` returns early without a `req.tenantCtx`. So there is nothing
 * recorded to reconstruct a base food's creator from, and inventing one would be
 * worse than the em dash the Details modal already renders for a missing value.
 * Gym-owned foods do write audit rows, but attributing only those would leave the
 * library showing a creator for some items and not others for reasons a reader
 * cannot see. Every item written after this migration carries its own snapshot.
 *
 * Each DDL statement and the backfill are guarded independently so a retry after a
 * partial failure (interrupted deploy, lock timeout) resumes instead of silently
 * skipping whatever did not finish.
 */

const TABLE = 'nutrition_library_items';

async function constraintExists(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = ?`,
    [TABLE, name],
  );
  return rows.length > 0;
}

/** The three actor pairs, each `<prefix>_by_name` + `<prefix>_by_type`. */
const ACTOR_PREFIXES = ['created', 'modified', 'deleted'];

/** Those pairs flattened, so each column is added and dropped under its own guard. */
const ACTOR_COLUMNS = ACTOR_PREFIXES.flatMap((prefix) => [
  { column: `${prefix}_by_name`, length: 255 },
  { column: `${prefix}_by_type`, length: 20 },
]);

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, 'description'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('description', 1000).nullable();
    });
  }

  // Guarded per column, not per pair: knex's mysql2 dialect batches ADDs into one
  // ALTER but emits a separate ALTER per DROP, so a pair-level guard keyed on
  // `_by_name` would skip a half-dropped pair forever and make a later `up()` fail
  // with ER_DUP_FIELDNAME on the surviving column.
  for (const { column, length } of ACTOR_COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, column))) {
      await knex.schema.alterTable(TABLE, (t) => { t.string(column, length).nullable(); });
    }
  }

  if (!(await knex.schema.hasColumn(TABLE, 'deleted_at'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.datetime('deleted_at').nullable();
    });
  }

  // `ADD CONSTRAINT` rebuilds the table under ALGORITHM=COPY, so the three go in
  // one statement rather than three — while still being individually guarded, so a
  // resumed run adds only what is missing.
  const missingChecks = [];
  for (const prefix of ACTOR_PREFIXES) {
    const name = `chk_nli_${prefix}_by_type`;
    if (!(await constraintExists(knex, name))) {
      missingChecks.push(
        `ADD CONSTRAINT ${name} ` +
        `CHECK (${prefix}_by_type IS NULL OR ${prefix}_by_type IN ('staff','superadmin'))`,
      );
    }
  }
  if (missingChecks.length > 0) {
    await knex.raw(`ALTER TABLE ${TABLE} ${missingChecks.join(', ')}`);
  }

  // See the header: `modified_at` on a deleted row *is* the deletion time.
  await knex.raw(
    `UPDATE ${TABLE} SET deleted_at = modified_at
     WHERE status = 'deleted' AND deleted_at IS NULL AND modified_at IS NOT NULL`,
  );
};

exports.down = async (knex) => {
  for (const prefix of ACTOR_PREFIXES) {
    const name = `chk_nli_${prefix}_by_type`;
    if (await constraintExists(knex, name)) {
      await knex.raw(`ALTER TABLE ${TABLE} DROP CHECK ${name}`);
    }
  }
  if (await knex.schema.hasColumn(TABLE, 'deleted_at')) {
    await knex.schema.alterTable(TABLE, (t) => t.dropColumn('deleted_at'));
  }
  for (const { column } of [...ACTOR_COLUMNS].reverse()) {
    if (await knex.schema.hasColumn(TABLE, column)) {
      await knex.schema.alterTable(TABLE, (t) => t.dropColumn(column));
    }
  }
  if (await knex.schema.hasColumn(TABLE, 'description')) {
    await knex.schema.alterTable(TABLE, (t) => t.dropColumn('description'));
  }
};
