/** #349: link payment_requests → billing_events so every payment is tied to a billing event */

exports.up = async (knex) => {
  const hasCol = await knex.schema.hasColumn('payment_requests', 'billing_event_id');
  if (hasCol) return;

  await knex.schema.alterTable('payment_requests', (t) => {
    t.integer('billing_event_id').unsigned().nullable().after('charge_type_id');
    t.foreign('billing_event_id').references('billing_events.id').onDelete('SET NULL');
    t.index('billing_event_id', 'idx_payment_requests_billing_event');
  });

  // Seed the feature flag for the new Billing Events nav item.
  await knex.raw(
    'INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at) VALUES (?, 1, UTC_TIMESTAMP())',
    ['payments.billing_events'],
  );
};

exports.down = async (knex) => {
  const hasCol = await knex.schema.hasColumn('payment_requests', 'billing_event_id');
  if (!hasCol) return;

  await knex.schema.alterTable('payment_requests', (t) => {
    t.dropForeign(['billing_event_id']);
    t.dropIndex([], 'idx_payment_requests_billing_event');
    t.dropColumn('billing_event_id');
  });
};
