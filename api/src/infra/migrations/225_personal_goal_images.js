/**
 * #1035 stage 2 — a **Personal Goal carries an image**, the one thing the
 * bucket tree in `docs/cloudflare_structure.md` asks for that had no subject in
 * the code: `{gym prefix}/goals/{personal_goal_id}-{personal_goal_name}.png` for
 * a gym's own goal and `cordel/goals/…` for a System one (§4, §5).
 *
 * ── One column, both kinds of row ───────────────────────────────────────────
 *
 * `personal_goals` holds System rows (`gym_id IS NULL`, administered from
 * Cordel) and each gym's own, and the column is **one** column for both — the
 * shape `nutrition_library_items.image_url` already has (migration 138, #715):
 * the ownership of the *row* is what decides which root its key hangs off, not a
 * second column or a flag. `api/src/domain/personalGoalImages.ts` is where that
 * is decided, and the two routers never reach into each other's root.
 *
 * It stores the **URL**, not the key, because that is what every other media
 * reference in this schema stores and what `buildStorageObjectUrl()` /
 * `storageKeyFromObjectUrl()` convert between — a second convention here would
 * make `mediaIdentity()`-style "is this the same object?" comparisons answer two
 * ways. VARCHAR(1024) matches `exercises.image_url` (migration 187) rather than
 * `nutrition_library_items`' 500: the key carries a gym folder prefix built from
 * a VARCHAR(255) gym name plus the goal's own name, and the row is written
 * *after* the object reaches R2, so an overflow would leave an orphan and a 500
 * instead of a clean rejection. (The key builder caps the name part as well, for
 * the same reason `sanitizeExerciseImageName()` does.)
 *
 * ── `nutrition_goals` is deliberately untouched ─────────────────────────────
 *
 * The two catalogues are two tables precisely so they can diverge (migration
 * 206's header, and migration 218 did exactly this for the target pair). The
 * ticket's tree names a `goals/` folder holding
 * `{personal_goal_id}-{personal_goal_name}.png` and nothing for a Nutrition
 * Goal, so `IMAGE_GOAL_KINDS` in `api/src/domain/goalLibrary.ts` is the one
 * place that says which kinds have the column — asked once by each router
 * rather than branched on per route, because a router that projected
 * `image_url` from `nutrition_goals` would answer ER_BAD_FIELD_ERROR, which the
 * global handler turns into a bare 500 (#966).
 *
 * ── No CHECK, and no backfill ───────────────────────────────────────────────
 *
 * There is nothing to constrain: any value is a URL this deployment built or a
 * NULL, and which of the two roots it may sit under is an *ownership* question
 * the routers answer against the row they already loaded — a CHECK cannot see
 * `gyms.storage_folder_prefix`. NULL is what every row written before this
 * migration means, and it reads as "no image" on every surface, so nothing is
 * generated, guessed or copied from another catalogue (the #716 rule: generating
 * the artwork is out of scope, and there is no fallback to another image).
 *
 * `down()` drops the column, which forgets which object each goal pointed at.
 * The objects themselves stay in the bucket — this migration never wrote one and
 * a migration has no business deleting one — so re-running `up()` leaves every
 * goal with no image and the orphans behind, which is a sweep rather than a
 * repair (`docs/go-to-production.md`).
 *
 * Guarded on its own statement: MySQL commits DDL implicitly, so a crash must
 * not make a re-run skip it (migrations 134/140/155/183/205/206/212/218).
 */

const GOAL_TABLE = 'personal_goals';

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(GOAL_TABLE, 'image_url'))) {
    // `AFTER target_unit` keeps the row readable in `DESCRIBE personal_goals`
    // (name · description · target pair · image) on a catalogue of seven System
    // rows plus a handful per gym, where a non-INSTANT mid-table ADD COLUMN
    // costs nothing — the same trade migration 218 made one column over.
    await knex.raw(
      `ALTER TABLE ${GOAL_TABLE} ADD COLUMN image_url VARCHAR(1024) NULL AFTER target_unit`,
    );
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn(GOAL_TABLE, 'image_url')) {
    await knex.raw(`ALTER TABLE ${GOAL_TABLE} DROP COLUMN image_url`);
  }
};
