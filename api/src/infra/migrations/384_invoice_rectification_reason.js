/**
 * #2567 stage 4: a rectifying invoice is its own `invoices` row linked to the
 * original by `related_invoice_id` (migration 380); this adds the one thing
 * only it carries, the reason it was issued.
 */
exports.up = async (knex) => {
  await knex.schema.alterTable('invoices', (t) => {
    t.string('rectification_reason', 500).nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('rectification_reason');
  });
};
