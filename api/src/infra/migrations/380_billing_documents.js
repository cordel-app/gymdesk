/**
 * #2567 stage 1: the data model for Billing Event documents.
 *
 * `invoices` is one FISCAL invoice (simplified or full); its not-paid and paid
 * PDFs are representations of that one row, so the four nullable key columns
 * hold the exact object key in the private bucket. The number is assigned only
 * on issue (`status` draft -> issued), so `fiscal_number` is nullable and
 * UNIQUE per gym/type/year once set. `related_invoice_id` links a rectifying
 * invoice (its own row and number) to the original.
 *
 * `receipt_documents` holds the stored PDF of a receipt (the number itself is
 * still `billing_events.receipt_number`).
 *
 * Nothing writes either table yet (stages 2-4). Append-only ledgers: created_*
 * only, no deletes.
 */
exports.up = async (knex) => {
  await knex.schema.createTable('invoices', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('billing_event_id').unsigned().notNullable()
      .references('id').inTable('billing_events').onDelete('CASCADE');
    t.string('invoice_type', 20).notNullable();
    t.string('status', 20).notNullable().defaultTo('draft');
    t.string('fiscal_number', 30).nullable();
    t.specificType('fiscal_year', 'SMALLINT UNSIGNED').nullable();
    t.string('customer_name', 255).nullable();
    t.string('customer_tax_id', 50).nullable();
    t.text('customer_address').nullable();
    t.datetime('issued_at').nullable();
    t.string('payment_status', 20).notNullable().defaultTo('not_paid');
    t.string('simplified_not_paid_pdf_key', 500).nullable();
    t.string('simplified_paid_pdf_key', 500).nullable();
    t.string('full_not_paid_pdf_key', 500).nullable();
    t.string('full_paid_pdf_key', 500).nullable();
    t.integer('related_invoice_id').unsigned().nullable()
      .references('id').inTable('invoices').onDelete('RESTRICT');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.string('created_by', 255).nullable();
    t.unique(['gym_id', 'invoice_type', 'fiscal_year', 'fiscal_number'], 'invoices_number_unique');
    t.index(['gym_id', 'billing_event_id'], 'invoices_event_idx');
  });
  await knex.raw(
    `ALTER TABLE invoices
       ADD CONSTRAINT chk_invoices_type CHECK (invoice_type IN ('simplified','full')),
       ADD CONSTRAINT chk_invoices_status CHECK (status IN ('draft','issued')),
       ADD CONSTRAINT chk_invoices_payment_status CHECK (payment_status IN ('not_paid','paid'))`);

  await knex.schema.createTable('receipt_documents', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('billing_event_id').unsigned().notNullable()
      .references('id').inTable('billing_events').onDelete('CASCADE');
    t.string('pdf_key', 500).notNullable();
    t.datetime('issued_at').notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.string('created_by', 255).nullable();
    t.unique(['billing_event_id'], 'receipt_documents_event_unique');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('receipt_documents');
  await knex.schema.dropTableIfExists('invoices');
};
