/**
 * #1711 — a Promotion carries an image: `promotions.image_url` (1080 × 1080
 * WebP) and `image_thumbnail_url` (256 × 256 WebP), the shape
 * `membership_plans` (278) uses.
 *
 * `api/src/domain/promotionImages.ts` is the one place the keys are built and
 * `POST`/`DELETE /promotions/:id/image` the only writers. NULL is what every
 * existing promotion means ("no image"): no backfill, no CHECK. Each column is
 * guarded on its own statement because MySQL commits DDL implicitly.
 * `down()` forgets which objects each row pointed at; they stay in the bucket.
 */

const TABLE = 'promotions';
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
