/**
 * #185: Cash receipt generation.
 *
 * 1. billing_events: add receipt_number (allocated gaplessly) and receipt_issued_at.
 * 2. gyms: add fiscal fields needed for factura simplificada (legal_name, cif,
 *    fiscal_address, fiscal_phone).
 * 3. receipt_sequences: one row per (gym, year) used to allocate gapless receipt
 *    numbers atomically via INSERT IGNORE + UPDATE.
 *
 * Note: tax_rates table is created by migration 112_tax_rates (ticket #311).
 */

exports.up = async (knex) => {
  // 1. billing_events: receipt fields
  if (!(await knex.schema.hasColumn('billing_events', 'receipt_number'))) {
    await knex.schema.alterTable('billing_events', (t) => {
      t.string('receipt_number', 20).nullable();
      t.datetime('receipt_issued_at').nullable();
    });
  }

  // 2. gyms: fiscal fields
  if (!(await knex.schema.hasColumn('gyms', 'legal_name'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.string('legal_name', 255).nullable();
      t.string('cif', 20).nullable();
      t.string('fiscal_address', 500).nullable();
      t.string('fiscal_phone', 50).nullable();
    });
  }

  // 3. receipt_sequences
  if (!(await knex.schema.hasTable('receipt_sequences'))) {
    await knex.schema.createTable('receipt_sequences', (t) => {
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.specificType('year', 'SMALLINT UNSIGNED').notNullable();
      t.specificType('last_seq', 'INT UNSIGNED').notNullable().defaultTo(0);
      t.primary(['gym_id', 'year']);
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('receipt_sequences');

  for (const col of ['fiscal_phone', 'fiscal_address', 'cif', 'legal_name']) {
    if (await knex.schema.hasColumn('gyms', col)) {
      await knex.schema.alterTable('gyms', (t) => t.dropColumn(col));
    }
  }

  for (const col of ['receipt_issued_at', 'receipt_number']) {
    if (await knex.schema.hasColumn('billing_events', col)) {
      await knex.schema.alterTable('billing_events', (t) => t.dropColumn(col));
    }
  }
};
