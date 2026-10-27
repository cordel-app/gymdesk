/**
 * #2123 stage 2 — who paid, kept apart from who benefits.
 *
 * `payment_requests.payer_member_id` and `billing_events.payer_member_id` record the Member
 * whose card was charged (the Family Owner when the beneficiary belongs to a family), while
 * `member_id` stays the beneficiary. NULL means "the beneficiary paid", which is what every
 * existing row means: nothing is backfilled and no historical row is rewritten. The FK is
 * SET NULL so a hard-deleted payer never takes a financial row with them.
 */
const TABLES = ['payment_requests', 'billing_events'];

exports.up = async (knex) => {
  for (const t of TABLES) {
    if (await knex.schema.hasColumn(t, 'payer_member_id')) continue;
    await knex.raw(`
      ALTER TABLE ${t}
        ADD COLUMN payer_member_id INT UNSIGNED NULL,
        ADD KEY ${t}_payer_member_index (payer_member_id),
        ADD CONSTRAINT ${t}_payer_member_fk FOREIGN KEY (payer_member_id) REFERENCES members (id) ON DELETE SET NULL
    `);
  }
};

exports.down = async (knex) => {
  for (const t of TABLES) {
    if (!(await knex.schema.hasColumn(t, 'payer_member_id'))) continue;
    await knex.raw(`ALTER TABLE ${t} DROP FOREIGN KEY ${t}_payer_member_fk`);
    await knex.raw(`ALTER TABLE ${t} DROP COLUMN payer_member_id`);
  }
};
