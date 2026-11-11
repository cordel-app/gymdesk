/**
 * #2125 M5d — a Product Set has no version number.
 *
 * Oscar's model (2026-11-03): each modification creates a new, independent
 * Product Set; `previous_product_set_id` is the historical link to the one it
 * replaces, and there are no version numbers. `version` was only ever read to
 * order a set's predecessors (the id orders them the same way: a successor is
 * inserted after the Active set it follows) and to label a set `v<N>`, which is
 * now `#<id>`. This migration drops it together with
 * `UNIQUE product_sets_chain_version (root_product_set_id, version)`; the FK on
 * `root_product_set_id` gets an index of its own first, since that composite
 * key was the one backing it. `root_product_set_id` itself is the next step.
 *
 * `down` re-adds the column and numbers each chain's sets by id (1, 2, …), which
 * is what the writer used to store, then restores the composite key and drops the plain index it replaced.
 */
exports.up = async (knex) => {
  const [idx] = await knex.raw(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'product_sets' AND index_name = 'product_sets_root_index'`);
  if (idx.length === 0) {
    await knex.raw('ALTER TABLE product_sets ADD KEY product_sets_root_index (root_product_set_id)');
  }
  const [uniq] = await knex.raw(
    `SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'product_sets' AND index_name = 'product_sets_chain_version'`);
  if (uniq.length > 0) {
    await knex.raw('ALTER TABLE product_sets DROP INDEX product_sets_chain_version');
  }
  if (await knex.schema.hasColumn('product_sets', 'version')) {
    await knex.raw('ALTER TABLE product_sets DROP COLUMN version');
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('product_sets', 'version'))) {
    await knex.raw('ALTER TABLE product_sets ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1 AFTER previous_product_set_id');
    await knex.raw(`
      UPDATE product_sets ps
        JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY COALESCE(root_product_set_id, id) ORDER BY id) AS n
                FROM product_sets) r ON r.id = ps.id
         SET ps.version = r.n`);
    await knex.raw('ALTER TABLE product_sets ADD UNIQUE KEY product_sets_chain_version (root_product_set_id, version)');
    await knex.raw('ALTER TABLE product_sets DROP INDEX product_sets_root_index');
  }
};
