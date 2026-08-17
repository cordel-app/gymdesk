/** #180: payment_requests — tracks each payment request lifecycle from creation through provider confirmation */

exports.up = async (knex) => {
  const exists = await knex.schema.hasTable('payment_requests');
  if (exists) return;

  await knex.schema.createTable('payment_requests', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'CHAR(36)').notNullable();
    t.integer('user_membership_id').unsigned().notNullable();
    t.integer('member_id').unsigned().notNullable();
    t.decimal('amount', 10, 2).notNullable();
    t.specificType('currency', 'CHAR(3)').notNullable().defaultTo('EUR');
    t.integer('charge_type_id').unsigned().notNullable();
    t.string('status', 20).notNullable().defaultTo('pending');
    t.string('provider', 32).notNullable().defaultTo('monei');
    t.string('provider_order', 64).nullable();
    t.string('provider_ref', 64).nullable();
    t.specificType('page_token', 'CHAR(36)').nullable();
    t.dateTime('page_token_expires').nullable();
    t.dateTime('consent_given_at').nullable();
    t.string('initiated_by', 64).nullable();
    t.string('source', 20).notNullable();
    t.dateTime('created_at').defaultTo(knex.raw('UTC_TIMESTAMP()'));
    t.dateTime('completed_at').nullable();

    // CHECK constraints inline — single atomic DDL statement
    t.check("status IN ('pending','completed','failed','expired')", [], 'chk_payment_requests_status');
    t.check("source IN ('admin','customer')", [], 'chk_payment_requests_source');

    // Lookup by page_token on every payment page load; unique enforces 1:1 with request
    t.unique(['page_token'], { indexName: 'uq_payment_requests_page_token' });
    // Lookup by provider_ref on every webhook reconciliation
    t.index(['provider_ref'], 'idx_payment_requests_provider_ref');

    t.foreign('gym_id').references('gyms.id').onDelete('CASCADE');
    t.foreign('user_membership_id').references('user_memberships.id').onDelete('CASCADE');
    t.foreign('member_id').references('members.id').onDelete('CASCADE');
    t.foreign('charge_type_id').references('charge_types.id').onDelete('RESTRICT');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('payment_requests');
};
