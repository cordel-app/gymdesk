/**
 * #2126 stage 5d-4 — a Promotion frozen onto a one-time purchase takes its id from its snapshot.
 *
 * A purchase's applied Promotion (`product_promotion_snapshots.source_purchase_promotion_id`, the id
 * `GET /members/:id/products` and `GET /me/products` report it under) was allocated by the legacy
 * `member_products_oneoff_promotion_snapshot` table. Since this stage the purchase writer
 * (`api/purchase-writer.ts`, `insertPurchasePromotion()`) inserts the Promotion snapshot first and uses
 * its own id as that id (`source_purchase_promotion_id = id`), writing the legacy row under the same id,
 * so the legacy table can be dropped without taking the id sequence with it. One table holds every
 * Promotion snapshot of a purchase (whichever of the two purchase snapshot tables its parent is in), so
 * its own primary key is unique across both and no allocator table is needed (unlike stage 5d-3).
 *
 * A historical row keeps its id: no row is rewritten. So that a new id can never equal a historical one
 * (the snapshot's own ids and the legacy ids were two independent sequences until now), the snapshot
 * table's AUTO_INCREMENT is moved above every id either has handed out — the legacy table's own counter
 * included (it covers a deleted draft's Promotion), its ids, the snapshots' `source_purchase_promotion_id`s
 * and the snapshots' own ids — plus a headroom for the deploy window (the previous API container still
 * lets the legacy table allocate while this runs). `ALTER TABLE … AUTO_INCREMENT` is a metadata change.
 *
 * `down` is a no-op: lowering an AUTO_INCREMENT is never needed and MySQL would raise it back anyway.
 */

const DEPLOY_HEADROOM = 1000;

exports.up = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT GREATEST(
        COALESCE((SELECT MAX(id) FROM member_products_oneoff_promotion_snapshot), 0),
        COALESCE((SELECT MAX(source_purchase_promotion_id) FROM product_promotion_snapshots), 0),
        COALESCE((SELECT MAX(id) FROM product_promotion_snapshots), 0)) AS top`);
  // MAX(id) misses an id whose row was deleted (InnoDB keeps the counter), so the legacy table's own
  // counter is read too — fresh, since MySQL 8 otherwise serves a cached information_schema value.
  await knex.raw('SET SESSION information_schema_stats_expiry = 0');
  const [counter] = await knex.raw(
    `SELECT AUTO_INCREMENT AS ai FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_products_oneoff_promotion_snapshot'`);
  const next = Math.max(Number(rows[0].top) + 1, Number(counter[0]?.ai ?? 0)) + DEPLOY_HEADROOM;
  if (!Number.isSafeInteger(next) || next < 1) throw new Error(`migration 414: unexpected id ${rows[0].top}`);
  await knex.raw(`ALTER TABLE product_promotion_snapshots AUTO_INCREMENT = ${next}`);
};

exports.down = async () => {};
