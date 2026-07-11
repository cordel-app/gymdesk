/**
 * P1.6 (#10): charge_types lookup + billing_events ledger.
 * charge_types is a global vocabulary (no gym_id), seeded like benefit_types.
 * billing_events is append-only: the API exposes GET/POST only, and status
 * changes on user_memberships insert a status_changed row in the same
 * transaction. FKs to members/user_memberships are SET NULL so ledger rows
 * outlive a hard-deleted parent; gym_id cascades with the tenant as usual.
 */

const SEED = [
  { code: 'membership_fee' },
  { code: 'registration_fee' },
  { code: 'insurance_fee' },
  { code: 'class_package' },
];

const EVENT_TYPES = ['charge_created', 'payment_recorded', 'status_changed', 'adjustment'];
const SOURCES = ['admin', 'system', 'employee', 'customer', 'provider'];

// MySQL DDL is non-transactional, so up() is guarded to be re-runnable
// against a partially-applied database.
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('charge_types'))) {
    await knex.schema.createTable('charge_types', (t) => {
      t.increments('id').primary();
      t.string('code', 40).notNullable().unique();
      t.boolean('active').notNullable().defaultTo(true);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    });
    await knex('charge_types').insert(SEED);
  }

  if (!(await knex.schema.hasTable('billing_events'))) {
    await knex.schema.createTable('billing_events', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('user_membership_id').unsigned()
        .references('id').inTable('user_memberships').onDelete('SET NULL');
      t.integer('member_id').unsigned()
        .references('id').inTable('members').onDelete('SET NULL');
      t.string('event_type', 30).notNullable();
      t.integer('charge_type_id').unsigned()
        .references('id').inTable('charge_types');
      t.string('previous_status', 20);
      t.string('new_status', 20);
      t.string('source', 20).notNullable();
      t.string('actor_user_id', 64);            // Clerk user id; NULL for system events
      t.decimal('amount', 10, 2);
      t.text('notes');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.index(['gym_id', 'created_at'], 'billing_events_gym_created_index');
      t.index(['member_id'], 'billing_events_member_index');
      t.index(['user_membership_id'], 'billing_events_membership_index');
    });
    await knex.raw(
      'ALTER TABLE billing_events ADD CONSTRAINT billing_events_event_type_check ' +
      `CHECK (event_type IN (${EVENT_TYPES.map((v) => `'${v}'`).join(',')}))`,
    );
    await knex.raw(
      'ALTER TABLE billing_events ADD CONSTRAINT billing_events_source_check ' +
      `CHECK (source IN (${SOURCES.map((v) => `'${v}'`).join(',')}))`,
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE billing_events DROP CHECK billing_events_event_type_check').catch(() => {});
  await knex.raw('ALTER TABLE billing_events DROP CHECK billing_events_source_check').catch(() => {});
  await knex.schema.dropTableIfExists('billing_events');
  await knex.schema.dropTableIfExists('charge_types');
};
