/**
 * #2126 stage 5d-3 — one allocator for one-time purchase ids.
 *
 * A bought one-time Product's id (`source_id` on its Product snapshot, what the routes, the Promotion
 * snapshots and the Billing Event links key on) was allocated by the legacy
 * `member_products_oneoff_snapshot` table. Its snapshot lives in one of **two** tables
 * (`product_session_snapshots` for a Sessions package, `product_oneoff_snapshots` for anything else,
 * stage 5a), each with its own sequence, so neither can hand out the id the way
 * `product_periodical_snapshots` does for a recurring line (stage 5d-2): two purchases could take the
 * same id in the two tables.
 *
 * `product_purchase_ids` is that allocator, and a registry: one row per purchase id ever handed out,
 * so an id is unique across both snapshot tables by the primary key. The purchase writer
 * (`api/purchase-writer.ts`) inserts a row, uses its id as the purchase id, and writes the snapshot
 * and the legacy record under it, so the legacy table no longer allocates anything.
 *
 * The backfill registers every historical id (the legacy rows and both snapshot tables' `source_id`s);
 * no purchase row is rewritten. AUTO_INCREMENT is then moved above every id either source has handed
 * out — the legacy table's own counter included, which covers a deleted draft — plus a headroom for the
 * deploy window (the previous API container still lets the legacy table allocate while this runs).
 * `ALTER TABLE … AUTO_INCREMENT` on this new table is a metadata change.
 *
 * `down` drops the table: the legacy record still holds every purchase id the writer handed out. Roll
 * the API back with it — `insertPurchase()` allocates here and has no fallback.
 */

const DEPLOY_HEADROOM = 1000;

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('product_purchase_ids'))) {
    await knex.raw(`
      CREATE TABLE product_purchase_ids (
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id     CHAR(36)     NOT NULL,
        created_at DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        KEY idx_ppi_gym (gym_id),
        CONSTRAINT fk_ppi_gym FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  // Every historical purchase id, once (a Sessions package and its legacy row share one).
  await knex.raw(`
    INSERT IGNORE INTO product_purchase_ids (id, gym_id, created_at)
    SELECT id, gym_id, created_at FROM member_products_oneoff_snapshot`);
  for (const table of ['product_session_snapshots', 'product_oneoff_snapshots']) {
    await knex.raw(`
      INSERT IGNORE INTO product_purchase_ids (id, gym_id, created_at)
      SELECT source_id, gym_id, created_at FROM ${table} WHERE source_id IS NOT NULL`);
  }

  const [rows] = await knex.raw('SELECT COALESCE(MAX(id), 0) AS top FROM product_purchase_ids');
  // MAX(id) misses an id whose legacy row was deleted (InnoDB keeps the counter), so the legacy
  // table's own counter is read too — fresh, since MySQL 8 otherwise serves a cached value.
  await knex.raw('SET SESSION information_schema_stats_expiry = 0');
  const [counter] = await knex.raw(
    `SELECT AUTO_INCREMENT AS ai FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_products_oneoff_snapshot'`);
  const next = Math.max(Number(rows[0].top) + 1, Number(counter[0]?.ai ?? 0)) + DEPLOY_HEADROOM;
  if (!Number.isSafeInteger(next) || next < 1) throw new Error(`migration 413: unexpected id ${rows[0].top}`);
  await knex.raw(`ALTER TABLE product_purchase_ids AUTO_INCREMENT = ${next}`);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE IF EXISTS product_purchase_ids');
};
