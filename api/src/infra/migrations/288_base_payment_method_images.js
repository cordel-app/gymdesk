/**
 * #1702 — a Base Payment Method's image: a 1080 × 1080 WebP master and a
 * 256 × 256 WebP thumbnail under `cordel/payment_method/`, referenced by two
 * nullable columns on `base_payment_methods`. Every existing row starts NULL;
 * nothing is backfilled. Guarded so a re-run is a no-op.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('base_payment_methods', 'image_url'))) {
    await knex.raw('ALTER TABLE base_payment_methods ADD COLUMN image_url VARCHAR(1024) NULL');
  }
  if (!(await knex.schema.hasColumn('base_payment_methods', 'image_thumbnail_url'))) {
    await knex.raw('ALTER TABLE base_payment_methods ADD COLUMN image_thumbnail_url VARCHAR(1024) NULL');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('base_payment_methods', 'image_thumbnail_url')) {
    await knex.raw('ALTER TABLE base_payment_methods DROP COLUMN image_thumbnail_url');
  }
  if (await knex.schema.hasColumn('base_payment_methods', 'image_url')) {
    await knex.raw('ALTER TABLE base_payment_methods DROP COLUMN image_url');
  }
};
