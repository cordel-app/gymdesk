/**
 * #1325 PR 3c — `user_memberships.next_billing_date` and `last_billed_at` go.
 *
 * Since PR 3a the nightly run executes a ProductSet's persisted Billing Events
 * and reads no assignment date; since PR 3b every money row belongs to a set.
 * The two columns were the assignment pass's schedule and its last-charge
 * stamp, and every surface that still reports them derives them from the
 * ledger (`domain/derivedBilling.ts`: the earliest unsettled obligation, the
 * latest money-moving attempt). Nothing writes them any more
 * (`domain/nextBillingDateStamp.ts` is deleted with this migration), so a
 * stored value could only disagree with the ledger.
 *
 * Nothing is read before dropping: a value left on a row is the retired pass's
 * and the ledger is the record. The columns came in with migration 111 and
 * carried no index of their own.
 */

exports.up = async (knex) => {
  for (const column of ['next_billing_date', 'last_billed_at']) {
    if (await knex.schema.hasColumn('user_memberships', column)) {
      await knex.raw(`ALTER TABLE user_memberships DROP COLUMN ${column}`);
    }
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('user_memberships', 'next_billing_date'))) {
    await knex.raw('ALTER TABLE user_memberships ADD COLUMN next_billing_date DATE NULL');
  }
  if (!(await knex.schema.hasColumn('user_memberships', 'last_billed_at'))) {
    await knex.raw('ALTER TABLE user_memberships ADD COLUMN last_billed_at DATETIME NULL');
  }
};
