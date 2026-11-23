/**
 * #3270 — a purchase (#3251's cart) has a name, persisted once when it is created.
 *
 * `purchases.name` holds the purchase's name basis: the UTC instant it was created, as an ISO 8601
 * string (`2026-11-23T11:56:00Z`). It is deliberately not a display string: the Admin composes what
 * a person reads — a translated "Purchase" label and that instant formatted in the browser's own
 * locale and time zone (`Purchase - 23/11/2026, 12:56`) — so no English word and no gym-zone date is
 * stored. `createPurchase()` (`api/purchases.ts`) writes it in the INSERT, from the same
 * `UTC_TIMESTAMP()` the row's `created_at` defaults to, and nothing updates it: editing the cart,
 * merging a newer cart into it or moving it through its statuses leaves the name as it was.
 *
 * Existing rows take the value from their own `created_at`, then the column becomes NOT NULL with
 * the same instant as its default (so a writer that names no `name` still gets one).
 * `down` drops the column.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('purchases', 'name'))) {
    await knex.raw('ALTER TABLE purchases ADD COLUMN name VARCHAR(32) NULL AFTER status');
  }
  await knex.raw(`UPDATE purchases SET name = DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') WHERE name IS NULL`);
  // The same expression `created_at` defaults to, so an API image still running the previous code
  // (which names no `name`) keeps creating carts during the deploy window or after a rollback.
  await knex.raw(`ALTER TABLE purchases MODIFY COLUMN name VARCHAR(32) NOT NULL
    DEFAULT (DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'))`);
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('purchases', 'name')) {
    await knex.raw('ALTER TABLE purchases DROP COLUMN name');
  }
};
