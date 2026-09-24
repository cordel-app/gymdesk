/**
 * #635 stage 9: a Promotion can be taken off an Assigned Plan and put back on.
 *
 * Where this comes from: the issue thread's answer to Q2 — *"Promotions can be
 * selectable and deselectable adjusting automatically the simulation letting
 * the staff or member choose what option suit better for him/her"*. Stage 7
 * shipped one half of that: clearing an application's checkbox revokes it. The
 * other half was impossible, and the stage-7 notes said so — `ump_unique_pair`
 * (migration 022) makes (user_membership_id, promotion_id) unique across
 * *every* status, so a revoked application permanently occupied the pair and
 * re-applying answered 409.
 *
 * What replaces it: the pair stays unique among the applications that are still
 * **standing**, and a revoked one becomes history that a new application can be
 * written beside. That is the same shape migration 164 uses for Additional
 * Periodic Services ("the same item may legitimately be attached twice over
 * non-overlapping windows; what must never happen is two *open* attachments"),
 * built the same way: a VIRTUAL generated column that is non-NULL only while
 * the row is standing, with a UNIQUE KEY over it. MySQL has no partial index,
 * and NULLs do not collide in a unique index, so this is exactly "at most one
 * applied row per (assignment, Promotion)" — enforced by the database, not only
 * by the API's SELECT-then-INSERT, so two concurrent POSTs cannot both win.
 *
 * VIRTUAL, not STORED: MySQL rejects a STORED generated column over a foreign
 * key column (same reason as migrations 007 and 164).
 *
 * Why history is kept rather than the revoked row being resurrected: an
 * application owns the snapshot of the Promotion it was agreed with (§16), and
 * `[applied_at, revoked_at]` is what tells the Billing Events range which
 * persisted charges that agreement touched (#511 stage 3, migration 150).
 * Re-using the row would overwrite both, rewriting what the member was already
 * billed under. A re-apply is therefore a new agreement, made now, with its own
 * snapshot — the same rule stage 6 applies to a newly added benefit line.
 *
 * Order matters below. `ump_unique_pair` is the index MySQL uses for the
 * `user_membership_id` foreign key (it is its leftmost column), so dropping it
 * first would fail with errno 150. The plain index that replaces it is created
 * before the drop and also keeps `WHERE user_membership_id = ? AND
 * promotion_id = ?` (the revoke path, the standing-application check) on an
 * index.
 *
 * No data migration: every existing row keeps its status, and a generated
 * column is computed on read. Each step is guarded on its own against
 * information_schema — ALTER TABLE is not transactional, so a crash between
 * two of them must not make a re-run skip one (migrations 134/140/155/164).
 */

const TABLE = 'user_membership_promotions';
const APPLIED_AT_DEFAULT = 'UTC_TIMESTAMP()';
const PAIR_INDEX = 'ump_membership_promotion_index';
const STANDING_COLUMN = 'standing_promotion_key';
const STANDING_UNIQUE = 'ump_one_standing_per_promotion';
const LEGACY_UNIQUE = 'ump_unique_pair';

async function hasIndex(knex, name) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [TABLE, name],
  );
  return Number(rows[0].cnt) > 0;
}

async function columnDefault(knex, column) {
  const [rows] = await knex.raw(
    `SELECT COLUMN_DEFAULT AS d FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [TABLE, column],
  );
  return rows.length > 0 ? String(rows[0].d ?? '') : null;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) return;

  // 1. The index the dropped unique key was also serving.
  if (!(await hasIndex(knex, PAIR_INDEX))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD INDEX ${PAIR_INDEX} (user_membership_id, promotion_id)`);
  }

  // 2. "Standing" is `status = 'applied'` — deliberately the same predicate
  //    every reader already filters on (`computeFinalPrice`, the stacking
  //    check, the member's own promotion list), so the database's invariant and
  //    the API's "is this Promotion on this assignment?" cannot drift apart.
  //    'consumed' and 'revoked' are both spent: neither bills anything, both
  //    read as `inactive` (promotionApplicationStatus()), and neither claims
  //    the pair. Nothing writes 'consumed' to this table today — a future
  //    status meaning "attached but spent" would have to be added here *and* to
  //    the apply path's check, or the two would disagree about who holds it.
  if (!(await knex.schema.hasColumn(TABLE, STANDING_COLUMN))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD COLUMN ${STANDING_COLUMN} VARCHAR(32) ` +
      "GENERATED ALWAYS AS (IF(status = 'applied', CONCAT(user_membership_id, ':', promotion_id), NULL)) VIRTUAL",
    );
  }
  if (!(await hasIndex(knex, STANDING_UNIQUE))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD UNIQUE KEY ${STANDING_UNIQUE} (${STANDING_COLUMN})`);
  }

  // 3. Only now is the all-statuses unique key removable.
  if (await hasIndex(knex, LEGACY_UNIQUE)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${LEGACY_UNIQUE}`);
  }

  // 4. `applied_at` and `revoked_at` now bound the *same* window, several times
  //    over per (assignment, promotion), so they have to share one clock.
  //    Migration 022 defaulted `applied_at` to `CURRENT_TIMESTAMP`, which is
  //    `NOW()` — evaluated in the server's session time zone — while the revoke
  //    path stamps `revoked_at = UTC_TIMESTAMP()`. On a non-UTC server the two
  //    are hours apart, which was survivable while one row per pair existed and
  //    is not once a replacement application's `applied_at` is compared against
  //    the `revoked_at` of the one it replaced (`promotionCoversDate()`, which
  //    decides whether a persisted charge was promotion-affected). Every insert
  //    path takes the default, so the column default is the one place to fix it.
  const appliedAtDefault = await columnDefault(knex, 'applied_at');
  if (appliedAtDefault != null && !/utc_timestamp/i.test(appliedAtDefault)) {
    await knex.raw(`ALTER TABLE ${TABLE} ALTER COLUMN applied_at SET DEFAULT (${APPLIED_AT_DEFAULT})`);
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) return;

  // Restoring the all-statuses unique key can only succeed while no assignment
  // carries two applications of the same Promotion — i.e. while nothing has
  // been re-applied. Keep the revoked duplicates rather than deleting an
  // agreement to make a rollback succeed (CLAUDE.md), and fail the rollback
  // loudly rather than returning: the schema is then still the post-183 one
  // (the standing key holds), and an operator reading a green rollback would
  // believe otherwise. Re-running `up()` afterwards converges — every step is
  // guarded — so nothing is left half-applied.
  if (!(await hasIndex(knex, LEGACY_UNIQUE))) {
    const [dupes] = await knex.raw(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT user_membership_id, promotion_id FROM ${TABLE}
         GROUP BY user_membership_id, promotion_id HAVING COUNT(*) > 1
       ) d`,
    );
    if (Number(dupes[0].cnt) > 0) {
      throw new Error(
        `[183] ${dupes[0].cnt} (assignment, promotion) pair(s) have more than one application, ` +
        `so ${LEGACY_UNIQUE} cannot be restored without deleting an agreed Promotion application. ` +
        `Rollback refused; ${STANDING_UNIQUE} is left in place and still enforces one standing application.`,
      );
    }
    await knex.raw(`ALTER TABLE ${TABLE} ADD UNIQUE KEY ${LEGACY_UNIQUE} (user_membership_id, promotion_id)`);
  }

  if (await hasIndex(knex, STANDING_UNIQUE)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${STANDING_UNIQUE}`);
  }
  if (await knex.schema.hasColumn(TABLE, STANDING_COLUMN)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${STANDING_COLUMN}`);
  }
  // PAIR_INDEX is left in place: `ump_unique_pair` covers the same prefix, and
  // dropping it is never required to get back to head's schema shape.
  //
  // `applied_at`'s default is left as `UTC_TIMESTAMP()` too. Putting the session
  // time zone back would re-introduce the skew against `revoked_at` and fix
  // nothing — the column is stamped by the database on insert, so no existing
  // row and no caller depends on which of the two it was.
};
