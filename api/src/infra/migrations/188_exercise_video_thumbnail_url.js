/**
 * #719 part 2: a Gym Exercise video carries its own **poster**.
 *
 * `exercises.video_url` (migration 023) has always been the one video reference
 * an exercise carries, and it is free text — in practice a YouTube link, and
 * from this part on an `.mp4` object in the gym's own R2 folder. §7 requires a
 * thumbnail that is *independently accessible*, "so the UI does not need to
 * download the MP4 simply to display a video preview": that is what
 * `video_thumbnail_url` holds.
 *
 * The column is the exact mirror of `image_thumbnail_url` (migration 187), and
 * for the same reasons:
 *
 *  - **A sibling, not a convention.** Deriving `…-thumbnail.png` from the
 *    video's URL would only hold for videos this feature uploaded. The column
 *    also has to be able to say "there is a video but no poster", which is every
 *    row that exists today — a YouTube link has no stored poster (the Admin and
 *    Member media helpers derive one from the URL when the column is NULL), and
 *    an exercise may equally carry a hand-typed link to a page.
 *  - **A URL, not a key.** It sits next to `video_url`, which has held a full
 *    URL since #417. Ownership — "may this object be deleted?" — is decided from
 *    the URL by `storageKeyFromObjectUrl()` + the gym's own
 *    `storage_folder_prefix` (§19), so a `cordel/…` System object and an
 *    external link are both recognised as *not the gym's* without a second
 *    column to record it.
 *
 * Nothing is backfilled and nothing is deleted (§23). Existing rows keep their
 * `video_url` and get a NULL poster, which every reader already tolerates: both
 * apps' media helpers (#720, #723) prefer `exercise_video_thumbnail_url` and
 * fall back to the YouTube still or a play tile until one arrives. There is no
 * fallback to a Base Exercise's media in either direction — #719's snapshot rule
 * — so a NULL here means "no stored poster", never "ask the library".
 *
 * **Both columns are VARCHAR(1024)**, exactly as migration 187 sized the image
 * pair: the poster URL is longer than the video's (`-thumbnail.png` in place of
 * `.mp4`), the two are written in one statement *after* both objects are in R2,
 * and the narrower of the two would decide the limit — an overflow there means
 * an orphaned object and a 500 rather than a clean rejection. The other half of
 * the guarantee is in `buildGymExerciseVideoKey()`, which caps the exercise name
 * inside the key so the length cannot grow with the catalogue.
 *
 * Widening a VARCHAR in place is non-destructive and needs no rewrite of the
 * data (both widths use the same 2-byte length prefix in utf8mb4), and nothing
 * reads a length limit off these columns.
 *
 * One consequence worth writing down: at VARCHAR(1024) utf8mb4 (4096 bytes) the
 * four media columns are past InnoDB's 3072-byte index key limit, so none of
 * them can carry a plain index any more. `isMediaStillReferenced()` equality-
 * matches all four, and is bounded by `gym_id` through `exercises_gym_name_index`
 * (a gym's catalogue is small); should it ever need an index of its own it has
 * to be a prefix index — `INDEX (video_url(191))` — never a plain one.
 *
 * `AFTER video_url` keeps the pair adjacent in `DESCRIBE exercises`, as
 * migrations 175, 180 and 187 do. On MySQL 8.0.29+ — this project targets 8.4,
 * and HeatWave in production — an ADD COLUMN at a position is still `INSTANT`,
 * so it does not rebuild the table.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('exercises', 'video_thumbnail_url'))) {
    await knex.raw(
      'ALTER TABLE exercises ADD COLUMN video_thumbnail_url VARCHAR(1024) NULL AFTER video_url',
    );
  }
  await knex.raw('ALTER TABLE exercises MODIFY COLUMN video_url VARCHAR(1024) NULL');
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('exercises', 'video_thumbnail_url')) {
    // The video stays: `video_url` is a column this migration never wrote, and
    // an exercise that has a video before the rollback still has one after it.
    // The poster objects survive in R2 unreferenced — a sweep, not data loss.
    await knex.raw('ALTER TABLE exercises DROP COLUMN video_thumbnail_url');
  }
  // `video_url` is deliberately left at VARCHAR(1024). Narrowing it back would
  // truncate or refuse any URL written while this migration was applied, which
  // is real data; the extra width costs nothing (VARCHAR stores what it holds)
  // and no reader depends on the limit.
};
