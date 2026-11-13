/**
 * #2126 stage 5d-2 — a recurring Product line's id comes from its snapshot.
 *
 * A recurring line's id (`product_periodical_snapshots.source_id`, what the routes, the consumption
 * ledger, the allowance renewals and `user_membership_promotions.recurrent_snapshot_id` key on) was
 * allocated by the legacy `member_products_recurrent_snapshot` table. Since this stage the line writer
 * (`api/recurring-line-writer.ts`) inserts the snapshot first and uses its own id as the line's id
 * (`source_id = id`), writing the legacy record under that same id, so the legacy table can later be
 * dropped without taking the id sequence with it.
 *
 * A historical line keeps its id: no row is rewritten. So that a new id can never equal a historical
 * one (the snapshot's own ids and the legacy ids were two independent sequences until now), this
 * migration moves the snapshot table's AUTO_INCREMENT above every id either sequence has handed out —
 * the legacy table's own counter (which also covers a deleted top row), its ids, the snapshots'
 * `source_id`s and the snapshots' own ids — plus a headroom for the deploy window (below).
 * `ALTER TABLE … AUTO_INCREMENT` is a metadata change (no rebuild).
 *
 * `down` is a no-op: lowering an AUTO_INCREMENT is never needed and MySQL would raise it back anyway.
 */

/**
 * The deploy runs migrations while the previous API container still serves, and that code still lets
 * the legacy table allocate a line id; the headroom keeps the ids it hands out in that window below
 * the first id the new writer takes.
 */
const DEPLOY_HEADROOM = 1000;

exports.up = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT GREATEST(
        COALESCE((SELECT MAX(id) FROM member_products_recurrent_snapshot), 0),
        COALESCE((SELECT MAX(source_id) FROM product_periodical_snapshots), 0),
        COALESCE((SELECT MAX(id) FROM product_periodical_snapshots), 0)) AS top`);
  // MAX(id) misses an id whose row was deleted (InnoDB keeps the counter), so the legacy table's own
  // counter is read too — fresh, since MySQL 8 otherwise serves a cached information_schema value.
  await knex.raw('SET SESSION information_schema_stats_expiry = 0');
  const [counter] = await knex.raw(
    `SELECT AUTO_INCREMENT AS ai FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_products_recurrent_snapshot'`);
  const next = Math.max(Number(rows[0].top) + 1, Number(counter[0]?.ai ?? 0)) + DEPLOY_HEADROOM;
  if (!Number.isSafeInteger(next) || next < 1) throw new Error(`migration 412: unexpected id ${rows[0].top}`);
  await knex.raw(`ALTER TABLE product_periodical_snapshots AUTO_INCREMENT = ${next}`);
};

exports.down = async () => {};
