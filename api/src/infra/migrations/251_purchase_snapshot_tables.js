/**
 * #1325 PR 2, purchases block — the purchase and service tables take the names
 * the ProductSet model gives them.
 *
 *   member_products               -> member_products_oneoff_snapshot
 *   member_product_promotions     -> member_products_oneoff_promotion_snapshot
 *   user_membership_services      -> member_products_recurrent_snapshot
 *
 * A rename and nothing else of substance: RENAME TABLE keeps every row, index
 * and foreign key (MySQL rewrites the FKs that point at a renamed table), so no
 * data moves and no reader needs a backfill.
 *
 * Two shape changes ride with it, both from the ticket's thread:
 *
 *  - `billing_event_id` leaves the one-off snapshot. A purchase's Billing Event
 *    is now reached through its payment request (`payment_requests
 *    .billing_event_id`), which is written when the purchase starts, so the
 *    snapshot no longer holds a second pointer to the same fact. The webhook
 *    already stamped that column on every completed purchase, so nothing is
 *    lost by dropping this one.
 *  - `product_id` becomes nullable with ON DELETE SET NULL. The snapshot is the
 *    record of what was bought; the link to the live Product is a convenience
 *    and must not forbid removing a Product (the snapshot columns carry the
 *    name, type, price and tax it was bought with).
 */

const RENAMES = [
  ['member_products', 'member_products_oneoff_snapshot'],
  ['member_product_promotions', 'member_products_oneoff_promotion_snapshot'],
  ['user_membership_services', 'member_products_recurrent_snapshot'],
];

const ONEOFF = 'member_products_oneoff_snapshot';

const constraintExists = async (knex, table, name) => {
  const rows = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return rows[0].length > 0;
};

exports.up = async (knex) => {
  for (const [from, to] of RENAMES) {
    if ((await knex.schema.hasTable(from)) && !(await knex.schema.hasTable(to))) {
      await knex.raw(`RENAME TABLE \`${from}\` TO \`${to}\``);
    }
  }

  if (await knex.schema.hasTable(ONEOFF)) {
    if (await constraintExists(knex, ONEOFF, 'mprod_billing_event_fk')) {
      await knex.raw(`ALTER TABLE ${ONEOFF} DROP FOREIGN KEY mprod_billing_event_fk`);
    }
    if (await knex.schema.hasColumn(ONEOFF, 'billing_event_id')) {
      await knex.raw(`ALTER TABLE ${ONEOFF} DROP COLUMN billing_event_id`);
    }
    if (await constraintExists(knex, ONEOFF, 'mprod_product_fk')) {
      await knex.raw(`ALTER TABLE ${ONEOFF} DROP FOREIGN KEY mprod_product_fk`);
    }
    await knex.raw(`ALTER TABLE ${ONEOFF} MODIFY COLUMN product_id INT UNSIGNED NULL`);
    await knex.raw(
      `ALTER TABLE ${ONEOFF} ADD CONSTRAINT mprod_product_fk FOREIGN KEY (product_id) `
      + 'REFERENCES products(id) ON DELETE SET NULL',
    );
  }
};

exports.down = async (knex) => {
  // Reversing would have to re-create `billing_event_id` from the payment
  // requests and refuse rows whose Product link is gone; the rename itself is
  // harmless to keep. Left as a no-op rather than half-reverting.
};
