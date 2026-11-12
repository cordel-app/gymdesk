/**
 * #2126 stage 5a — a bought Sessions package reaches its payment the way any other one-time purchase does.
 *
 * Owner's decision (#2126, 2026-11-12, option A): a one-time purchase reaches its payment through
 * `Payment Request -> Billing Event <-> snapshot`. `billing_event_oneoff_snapshots` (migration 366) covers
 * `product_oneoff_snapshots`; a Sessions package is frozen in `product_session_snapshots`, so it gets the
 * same junction of its own. Sessions packages stay in their own snapshot table.
 *
 * Same shape as 366's junctions with 375's rule: UNIQUE on the pair, both FKs ON DELETE CASCADE (the
 * snapshot is re-derived and deleted by the purchase sync while the legacy record still exists).
 *
 * Backfill: every Sessions purchase whose payment request carries a Billing Event, exactly as migration
 * 374 did for the one-off junction. Repeatable (`INSERT IGNORE`); a purchase whose request has no Billing
 * Event is left unlinked and is reported by `npm run product-snapshots:validate`. `down` drops the table.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('billing_event_session_snapshots'))) {
    await knex.raw(`
      CREATE TABLE billing_event_session_snapshots (
        id                          INT UNSIGNED NOT NULL AUTO_INCREMENT,
        billing_event_id            INT UNSIGNED NOT NULL,
        product_session_snapshot_id INT UNSIGNED NOT NULL,
        created_at                  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY bessn_pair_key (billing_event_id, product_session_snapshot_id),
        KEY bessn_snapshot_index (product_session_snapshot_id),
        CONSTRAINT bessn_owner_fk FOREIGN KEY (billing_event_id) REFERENCES billing_events (id) ON DELETE CASCADE,
        CONSTRAINT bessn_snapshot_fk FOREIGN KEY (product_session_snapshot_id)
          REFERENCES product_session_snapshots (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  await knex.raw(
    `INSERT IGNORE INTO billing_event_session_snapshots (billing_event_id, product_session_snapshot_id)
     SELECT pr.billing_event_id, s.id
       FROM member_products_oneoff_snapshot mp
       JOIN payment_requests pr ON pr.id = mp.payment_request_id AND pr.gym_id = mp.gym_id
       JOIN product_session_snapshots s ON s.source_id = mp.id AND s.gym_id = mp.gym_id
      WHERE pr.billing_event_id IS NOT NULL`);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('billing_event_session_snapshots');
};
