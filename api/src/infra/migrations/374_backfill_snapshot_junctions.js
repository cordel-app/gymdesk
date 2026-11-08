/**
 * #2125 / #2126 M2 — fills the Product Set / Billing Event <-> snapshot junctions (migration 366) for the
 * rows that already exist. From here the writers keep them (`api/src/api/snapshot-junction-sync.ts`).
 * Each statement is `INSERT IGNORE` over the pair's UNIQUE key, so it is repeatable and adds only what is
 * missing; nothing is changed or removed. A table that does not exist yet is skipped. `down` is a no-op
 * (the junctions are dropped by 366's own `down`).
 */
const SET_PAIRS = [
  ['product_set_plan_snapshots', 'plan_snapshot_id', 'plan_snapshots'],
  ['product_set_periodical_snapshots', 'product_periodical_snapshot_id', 'product_periodical_snapshots'],
  ['product_set_session_snapshots', 'product_session_snapshot_id', 'product_session_snapshots'],
  ['product_set_oneoff_snapshots', 'product_oneoff_snapshot_id', 'product_oneoff_snapshots'],
];

exports.up = async (knex) => {
  for (const [junction, col, table] of SET_PAIRS) {
    if (!(await knex.schema.hasTable(junction)) || !(await knex.schema.hasTable(table))) continue;
    await knex.raw(
      `INSERT IGNORE INTO ${junction} (product_set_id, ${col})
       SELECT s.product_set_id, s.id FROM ${table} s WHERE s.product_set_id IS NOT NULL`);
  }
  if ((await knex.schema.hasTable('billing_event_oneoff_snapshots'))
      && (await knex.schema.hasTable('product_oneoff_snapshots'))
      && (await knex.schema.hasTable('member_products_oneoff_snapshot'))) {
    await knex.raw(
      `INSERT IGNORE INTO billing_event_oneoff_snapshots (billing_event_id, product_oneoff_snapshot_id)
       SELECT pr.billing_event_id, s.id
         FROM member_products_oneoff_snapshot mp
         JOIN payment_requests pr ON pr.id = mp.payment_request_id AND pr.gym_id = mp.gym_id
         JOIN product_oneoff_snapshots s ON s.source_id = mp.id AND s.gym_id = mp.gym_id
        WHERE pr.billing_event_id IS NOT NULL`);
  }
};

exports.down = async () => {};
