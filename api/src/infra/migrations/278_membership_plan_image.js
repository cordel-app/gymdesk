/**
 * #1514 — a Membership Plan carries an image: `membership_plans.image_url`
 * (1080 × 1080 WebP) and `image_thumbnail_url` (256 × 256 WebP), the shape
 * `members` 253/275 use.
 *
 * `api/src/domain/planImages.ts` is the one place the keys are built and
 * `POST`/`DELETE /membership-plans/:id/image` the only writers. NULL is what
 * every existing plan means ("no image"): no backfill, no CHECK
 * (`ADD CONSTRAINT` would rebuild the table under `ALGORITHM=COPY`).
 * `down()` forgets which objects each row pointed at; they stay in the bucket.
 *
 * Each column is guarded on its own statement: MySQL commits DDL implicitly,
 * so a crash must not make a re-run skip the second one.
 */

const TABLE = 'membership_plans';
const COLUMNS = ['image_url', 'image_thumbnail_url'];

exports.up = async (knex) => {
  for (const column of COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, column))) {
      await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${column} VARCHAR(1024) NULL`);
    }
  }
};

exports.down = async (knex) => {
  for (const column of [...COLUMNS].reverse()) {
    if (await knex.schema.hasColumn(TABLE, column)) {
      await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${column}`);
    }
  }
};
