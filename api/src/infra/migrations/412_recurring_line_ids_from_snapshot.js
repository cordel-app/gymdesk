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
 * migration moves the snapshot table's AUTO_INCREMENT above the largest id either sequence has
 * handed out — the legacy ids, the snapshots' `source_id`s and the snapshots' own ids. On an empty
 * table it changes nothing. `ALTER TABLE … AUTO_INCREMENT` is a metadata change (no rebuild).
 *
 * `down` is a no-op: lowering an AUTO_INCREMENT is never needed and MySQL would raise it back anyway.
 */

exports.up = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT GREATEST(
        COALESCE((SELECT MAX(id) FROM member_products_recurrent_snapshot), 0),
        COALESCE((SELECT MAX(source_id) FROM product_periodical_snapshots), 0),
        COALESCE((SELECT MAX(id) FROM product_periodical_snapshots), 0)) AS top`);
  const next = Number(rows[0].top) + 1;
  if (!Number.isSafeInteger(next) || next < 1) throw new Error(`migration 412: unexpected id ${rows[0].top}`);
  await knex.raw(`ALTER TABLE product_periodical_snapshots AUTO_INCREMENT = ${next}`);
};

exports.down = async () => {};
