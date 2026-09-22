/**
 * #640: Billing Events context menu — Details, Retry Payment and Manual payment.
 *
 * 1. `billing_events.modified_at` / `modified_by_user_id`: the ledger is
 *    append-only for *financial* rows, but the Details view (§2) asks for
 *    "Modified At / Modified By" and the payment actions do stamp the parent
 *    row (receipt numbering already did, see `payments.ts`). The actor column
 *    mirrors the table's own existing convention — `actor_user_id VARCHAR(64)`,
 *    a Clerk user id — rather than the `modified_by_membership_id` FK used by
 *    the newer catalog tables, so both actor columns on this table resolve
 *    through the same `gym_memberships.user_id` lookup.
 *
 * 2. The same two columns on `payment_requests` (Payment Transactions), for
 *    the same reason: a retry or a manual payment records who touched the
 *    transaction and when.
 *
 * 3. `payment_requests.failure_code` / `failure_message`: the provider's
 *    rejection reason. Until now a failed MIT charge only wrote the reason
 *    into `billing_events.notes`, so the transaction row itself carried no
 *    "why", which §2's "Failure/rejection reason, when available" needs.
 *
 * 4. `payment_requests.notes`: the free-text reference an admin types when
 *    recording a manual (front-desk) payment.
 *
 * 5. `payment_requests.attempt`: which attempt of a charge produced the row.
 *    A Retry Payment action fires the provider charge and, if it fails, once
 *    more (see `retryBillingEventPayment`) — each attempt gets its own row, so
 *    the attempt number is what makes the pair readable. Existing rows are
 *    backfilled *positionally* per billing event rather than left at the
 *    column default: two historical `billing_run` failures both reading
 *    "attempt 1" would both mislabel the Details view and make
 *    `MAX(attempt)` under-count when the next retry picks its number.
 *
 * 6. `chk_payment_requests_source` gains `retry` and `manual` so the two new
 *    origins are distinguishable from the `admin` hosted-page flow and from
 *    the nightly `billing_run`.
 *
 * 7. `idx_payment_requests_event_recent`: the new status derivation runs
 *    `WHERE billing_event_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
 *    as a correlated subquery per listed row. The existing single-column
 *    `idx_payment_requests_billing_event` satisfies the equality but not the
 *    ordering — same reasoning as migration 150's composite index.
 */

/** MySQL: ER_CHECK_CONSTRAINT_NOT_FOUND — the only error a DROP CHECK may swallow. */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const dropCheckIfExists = (knex, sql) =>
  knex.raw(sql).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('billing_events', 'modified_at'))) {
    await knex.schema.alterTable('billing_events', (t) => {
      t.dateTime('modified_at').nullable();
      t.string('modified_by_user_id', 64).nullable();
    });
  }

  if (!(await knex.schema.hasColumn('payment_requests', 'modified_at'))) {
    await knex.schema.alterTable('payment_requests', (t) => {
      t.dateTime('modified_at').nullable();
      t.string('modified_by_user_id', 64).nullable();
    });
  }

  if (!(await knex.schema.hasColumn('payment_requests', 'failure_code'))) {
    await knex.schema.alterTable('payment_requests', (t) => {
      t.string('failure_code', 64).nullable();
      t.string('failure_message', 500).nullable();
    });
  }

  if (!(await knex.schema.hasColumn('payment_requests', 'notes'))) {
    await knex.schema.alterTable('payment_requests', (t) => {
      t.string('notes', 500).nullable();
    });
  }

  if (!(await knex.schema.hasColumn('payment_requests', 'attempt'))) {
    await knex.schema.alterTable('payment_requests', (t) => {
      t.integer('attempt').unsigned().notNullable().defaultTo(1);
    });
    // Runs exactly once, inside the same guard as the column itself.
    await knex.raw(`
      UPDATE payment_requests pr
        JOIN (SELECT id, ROW_NUMBER() OVER (
                       PARTITION BY billing_event_id ORDER BY created_at, id) AS rn
                FROM payment_requests
               WHERE billing_event_id IS NOT NULL) x ON x.id = pr.id
         SET pr.attempt = x.rn
    `);
  }

  const prIdx = await knex.raw('SHOW INDEX FROM payment_requests WHERE Key_name = ?', [
    'idx_payment_requests_event_recent',
  ]);
  if (prIdx[0].length === 0) {
    await knex.schema.alterTable('payment_requests', (t) => {
      t.index(['billing_event_id', 'created_at', 'id'], 'idx_payment_requests_event_recent');
    });
  }

  // Extend the source CHECK (see 111_billing_run.js for the previous widening).
  await dropCheckIfExists(knex, 'ALTER TABLE payment_requests DROP CHECK chk_payment_requests_source');
  await knex.raw(
    'ALTER TABLE payment_requests ADD CONSTRAINT chk_payment_requests_source ' +
    "CHECK (source IN ('admin','customer','billing_run','retry','manual'))",
  );
};

exports.down = async (knex) => {
  // Narrowing the CHECK fails once a retry/manual row exists, and a swallowed
  // failure would leave the column with *no* constraint at all — so decide
  // before dropping, and keep the widened CHECK when narrowing is impossible.
  const countRows = await knex.raw(
    "SELECT COUNT(*) AS n FROM payment_requests WHERE source IN ('retry','manual')",
  );
  if (Number(countRows[0][0].n) === 0) {
    await dropCheckIfExists(knex, 'ALTER TABLE payment_requests DROP CHECK chk_payment_requests_source');
    await knex.raw(
      'ALTER TABLE payment_requests ADD CONSTRAINT chk_payment_requests_source ' +
      "CHECK (source IN ('admin','customer','billing_run'))",
    );
  }

  const prIdx = await knex.raw('SHOW INDEX FROM payment_requests WHERE Key_name = ?', [
    'idx_payment_requests_event_recent',
  ]);
  if (prIdx[0].length > 0) {
    await knex.schema.alterTable('payment_requests', (t) => {
      t.dropIndex([], 'idx_payment_requests_event_recent');
    });
  }

  // One guard per column: knex emits a separate, non-transactional ALTER per
  // dropColumn, so a pair behind a single guard can half-apply and then be
  // skipped forever on re-run.
  for (const [table, col] of [
    ['payment_requests', 'attempt'],
    ['payment_requests', 'notes'],
    ['payment_requests', 'failure_message'],
    ['payment_requests', 'failure_code'],
    ['payment_requests', 'modified_by_user_id'],
    ['payment_requests', 'modified_at'],
    ['billing_events', 'modified_by_user_id'],
    ['billing_events', 'modified_at'],
  ]) {
    if (await knex.schema.hasColumn(table, col)) {
      await knex.schema.alterTable(table, (t) => t.dropColumn(col));
    }
  }
};
