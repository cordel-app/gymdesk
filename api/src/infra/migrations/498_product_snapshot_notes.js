/**
 * #3541 — a Product snapshot keeps the Product's Notes as they were when it was written.
 *
 * `notes` (TEXT, nullable, like `products.notes`) on the three Product snapshot tables
 * (`product_oneoff_snapshots`, `product_session_snapshots`, `product_periodical_snapshots`).
 * The writers copy it from the Product when a snapshot is created (`insertPurchase()`,
 * `insertRecurringLine()`) and from the source snapshot when one is copied (`copyLine()`),
 * and the purchase reads report it instead of the live `products.notes`.
 *
 * No backfill: what a Product's Notes said when an existing snapshot was written is not
 * known, and copying today's Notes would present them as historical. A legacy snapshot
 * therefore reads NULL (no Notes shown). The image is not snapshotted (#3541 §3).
 * A nullable column appended last; MySQL 8 normally adds it with ALGORITHM=INSTANT.
 */
const TABLES = ['product_oneoff_snapshots', 'product_session_snapshots', 'product_periodical_snapshots'];

exports.up = async (knex) => {
  for (const table of TABLES) {
    if (await knex.schema.hasColumn(table, 'notes')) continue;
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN notes TEXT NULL`);
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'notes'))) continue;
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN notes`);
  }
};
