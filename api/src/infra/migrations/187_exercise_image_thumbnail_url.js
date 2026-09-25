/**
 * #719 part 1: a Gym Exercise image is a **master plus a thumbnail**.
 *
 * `exercises.image_url` (migration 023) has always been the one image reference
 * an exercise carries, and every consumer added since — the workout trees and
 * the exercise selectors (#720), My Training Plan (#723) — renders it directly.
 * #719 §5 splits that into two: a 2048×2048 master and the 512×512 thumbnail
 * every list row is supposed to draw instead of downloading the master.
 *
 * `image_thumbnail_url` is that second reference. Deliberately a *sibling
 * column* rather than a derived name or a stored object key:
 *
 *  - **A sibling, not a convention.** Deriving `…-thumbnail.png` from the
 *    master's URL would only hold for images this feature uploaded. The column
 *    also has to be able to say "there is a master but no thumbnail", which is
 *    every row that exists today: `POST /storage/uploads/exercise-image` (#417)
 *    writes a single `<uuid>.png`, and an exercise may equally carry a
 *    hand-typed external URL.
 *  - **A URL, not a key.** It sits next to `image_url`, which has held a full
 *    URL since #417; a row that mixed the two would make every reader ask which
 *    kind it was holding. Ownership — "may this object be deleted?" — is decided
 *    from the URL by `storageKeyFromObjectUrl()` + the gym's own
 *    `storage_folder_prefix` (§19), so a `cordel/…` System object and an
 *    external link are both recognised as *not the gym's* without a second
 *    column to record it.
 *
 * Nothing is backfilled and nothing is deleted (§23). Existing rows keep their
 * `image_url` and get a NULL thumbnail, which every reader already tolerates:
 * both apps' media helpers (#720, #723) prefer the thumbnail and fall back to
 * the master, so this migration is invisible until a gym uploads through the new
 * `POST /exercises/:id/image`. There is no fallback to a Base Exercise's media
 * in either direction — #719's snapshot rule — so a NULL here means "no
 * thumbnail", never "ask the library".
 *
 * **Both columns are VARCHAR(1024).** A thumbnail URL is always exactly ten
 * characters longer than its master's — `-thumbnail` before the extension — so
 * equal widths alone would leave a ten-character band in which the master
 * stores and its companion overflows; and the row is written *after* both
 * objects are in R2, so an overflow means an orphaned object and a 500 rather
 * than a clean rejection. 500 (migration 023) is not enough headroom either:
 * the URL is endpoint + bucket + `gyms/<uuid>-<sanitized gym name>` +
 * `/Exercises/Images/<id>-<name>-thumbnail.png`, and `gyms.name` alone is
 * VARCHAR(255). `image_url` is widened to match, because the pair is written in
 * one statement and the narrower of the two would decide the limit. The other
 * half of the guarantee is in `buildGymExerciseImageKey()`, which caps the
 * exercise name inside the key so the length cannot grow with the catalogue.
 *
 * Widening a VARCHAR in place is non-destructive and needs no rewrite of the
 * data (both widths use the same 2-byte length prefix in utf8mb4), and nothing
 * reads a length limit off these columns.
 *
 * `AFTER image_url` keeps the pair adjacent in `DESCRIBE exercises`, as
 * migrations 175 and 180 do. On MySQL 8.0.29+ — this project targets 8.4, and
 * HeatWave in production — an ADD COLUMN at a position is still `INSTANT`, so
 * it does not rebuild the table.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('exercises', 'image_thumbnail_url'))) {
    await knex.raw(
      'ALTER TABLE exercises ADD COLUMN image_thumbnail_url VARCHAR(1024) NULL AFTER image_url',
    );
  }
  await knex.raw('ALTER TABLE exercises MODIFY COLUMN image_url VARCHAR(1024) NULL');
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('exercises', 'image_thumbnail_url')) {
    // The master stays: `image_url` is a column this migration never wrote, and
    // an exercise that has an image before the rollback still has one after it.
    // The thumbnail objects survive in R2 unreferenced — a sweep, not data loss.
    await knex.raw('ALTER TABLE exercises DROP COLUMN image_thumbnail_url');
  }
  // `image_url` is deliberately left at VARCHAR(1024). Narrowing it back to 500
  // would truncate or refuse any URL written while this migration was applied,
  // which is real data; the extra width costs nothing (VARCHAR stores what it
  // holds) and no reader depends on the limit.
};
