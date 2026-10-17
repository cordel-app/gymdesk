/**
 * #1715 — a Product carries an image: `products.image_url` (1080 × 1080 WebP)
 * and `image_thumbnail_url` (256 × 256 WebP), the shape `promotions` (289) uses.
 *
 * `api/src/domain/productImages.ts` is the one place the keys are built and
 * `POST`/`DELETE /products/:id/image` the only writers. NULL is what every
 * existing product means ("no image"): no backfill, no CHECK. Each column is
 * guarded on its own statement because MySQL commits DDL implicitly.
 * `down()` forgets which objects each row pointed at; they stay in the bucket.
 */

const TABLE = 'products';
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
