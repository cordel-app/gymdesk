/**
 * #1765 — a Calendar Event's own image moves onto the shared WebP pipeline's
 * two-reference shape (the Membership Plan's, #1514): a 1080 × 1080 WebP master
 * in `image_url` (#1382) and a 256 × 256 WebP thumbnail in the new
 * `image_thumbnail_url`, stored under the gym's `calendar_events/` folder.
 *
 * NULL is what every existing event means for the thumbnail: no backfill, no
 * CHECK (`ADD CONSTRAINT` would rebuild the table under `ALGORITHM=COPY`) and no
 * existing object is touched. An event whose `image_url` still points at a
 * pre-#1765 `activities/event-…` object keeps rendering from it; replacing or
 * removing that image is what moves it.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('calendar_events', 'image_thumbnail_url'))) {
    await knex.raw('ALTER TABLE calendar_events ADD COLUMN image_thumbnail_url VARCHAR(1024) NULL');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('calendar_events', 'image_thumbnail_url')) {
    await knex.raw('ALTER TABLE calendar_events DROP COLUMN image_thumbnail_url');
  }
};
