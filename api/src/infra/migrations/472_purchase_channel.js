/**
 * #3278 — `purchases.channel`: the application a Purchase was initiated through.
 *
 * `admin_app` or `members_app`, decided by the server from the route that created the purchase
 * (`domain/purchaseChannel.ts`) and written once by `createPurchase()` (`api/purchases.ts`); nothing
 * updates it. NULL where no application initiated it (a system run) and on every existing row:
 * no stored fact says which application created them (`created_by` is a name and a line's `origin`
 * is the line's, not the purchase's), so nothing is backfilled rather than guessed.
 * `down` drops the column and its CHECK.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('purchases', 'channel'))) {
    await knex.raw(`ALTER TABLE purchases
      ADD COLUMN channel VARCHAR(20) NULL AFTER created_by,
      ADD CONSTRAINT chk_purchases_channel CHECK (channel IS NULL OR channel IN ('admin_app', 'members_app'))`);
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('purchases', 'channel')) {
    await knex.raw('ALTER TABLE purchases DROP CHECK chk_purchases_channel, DROP COLUMN channel');
  }
};
