/**
 * #184: Recurring billing run — MIT charges (Phase 2).
 *
 * 1. user_memberships: add next_billing_date (set by webhook on first payment)
 *    and last_billed_at (stamped after each successful MIT charge).
 * 2. billing_run_log: single-row table used to enforce a 23-hour rate limit
 *    on POST /billing/run, preventing accidental double-billing if the cron
 *    fires twice.
 * 3. billing_events.event_type CHECK: extend to include recurring_payment and
 *    failed_billing (MIT-specific event types).
 * 4. payment_requests.source CHECK: extend to include billing_run so MIT
 *    charges appear in the Transactions page alongside manual requests.
 */

exports.up = async (knex) => {
  // 1a. Add next_billing_date to user_memberships
  if (!(await knex.schema.hasColumn('user_memberships', 'next_billing_date'))) {
    await knex.schema.alterTable('user_memberships', (t) => {
      t.date('next_billing_date').nullable();
    });
  }

  // 1b. Add last_billed_at to user_memberships
  if (!(await knex.schema.hasColumn('user_memberships', 'last_billed_at'))) {
    await knex.schema.alterTable('user_memberships', (t) => {
      t.dateTime('last_billed_at').nullable();
    });
  }

  // 2. Create billing_run_log (single-row rate-limit table).
  // Deliberate exception: no gym_id — this is a system-wide singleton, not a
  // per-tenant domain table.
  if (!(await knex.schema.hasTable('billing_run_log'))) {
    await knex.schema.createTable('billing_run_log', (t) => {
      t.specificType('id', 'TINYINT UNSIGNED').notNullable().defaultTo(1).primary();
      t.dateTime('last_run_at').nullable();
    });
    await knex.raw(
      'ALTER TABLE billing_run_log ADD CONSTRAINT chk_billing_run_log_id CHECK (id = 1)',
    );
    await knex.raw('INSERT IGNORE INTO billing_run_log (id, last_run_at) VALUES (1, NULL)');
  }

  // 3. Extend billing_events.event_type CHECK
  await knex.raw('ALTER TABLE billing_events DROP CHECK billing_events_event_type_check').catch(() => {});
  await knex.raw(
    "ALTER TABLE billing_events ADD CONSTRAINT billing_events_event_type_check " +
    "CHECK (event_type IN ('charge_created','payment_recorded','status_changed','adjustment','recurring_payment','failed_billing'))",
  );

  // 4. Extend payment_requests.source CHECK
  await knex.raw('ALTER TABLE payment_requests DROP CHECK chk_payment_requests_source').catch(() => {});
  await knex.raw(
    "ALTER TABLE payment_requests ADD CONSTRAINT chk_payment_requests_source " +
    "CHECK (source IN ('admin','customer','billing_run'))",
  );
};

exports.down = async (knex) => {
  // Restore billing_events.event_type CHECK to original set
  await knex.raw('ALTER TABLE billing_events DROP CHECK billing_events_event_type_check').catch(() => {});
  await knex.raw(
    "ALTER TABLE billing_events ADD CONSTRAINT billing_events_event_type_check " +
    "CHECK (event_type IN ('charge_created','payment_recorded','status_changed','adjustment'))",
  );

  // Restore payment_requests.source CHECK
  await knex.raw('ALTER TABLE payment_requests DROP CHECK chk_payment_requests_source').catch(() => {});
  await knex.raw(
    "ALTER TABLE payment_requests ADD CONSTRAINT chk_payment_requests_source " +
    "CHECK (source IN ('admin','customer'))",
  );

  await knex.schema.dropTableIfExists('billing_run_log');

  if (await knex.schema.hasColumn('user_memberships', 'last_billed_at')) {
    await knex.schema.alterTable('user_memberships', (t) => {
      t.dropColumn('last_billed_at');
    });
  }
  if (await knex.schema.hasColumn('user_memberships', 'next_billing_date')) {
    await knex.schema.alterTable('user_memberships', (t) => {
      t.dropColumn('next_billing_date');
    });
  }
};
