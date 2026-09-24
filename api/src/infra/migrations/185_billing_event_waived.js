/**
 * #635 stage 11 — the nightly billing run stops charging a waived cycle.
 *
 * Since stage 8 the Billing Simulation (and, since stage 10, the Member's own
 * My Membership page) shows €0 for a cycle covered by the assignment's Free
 * Period or Bonus Duration, or by an applied Promotion's free month. The
 * nightly run charged `final_price` regardless. It now resolves the fee for
 * the date it is billing and, when nothing is owed, records the cycle instead
 * of charging it — which needs a ledger vocabulary for "nothing was owed".
 *
 * `waived_billing` is that vocabulary: amount 0, `source = 'system'`, its
 * `notes` naming the period that produced it (`free_plan`, `bonus_promotion`,
 * …). It carries no `payment_requests` row — nothing was attempted — so
 * `deriveBillingEventStatus` reads it through `statusFromEventType`, whose
 * default is `recorded`: informational, never payment-actionable, which is
 * exactly right for a cycle that was never charged.
 *
 * Only the CHECK changes. No table, no column, no backfill: every existing row
 * keeps the type it was written with, and the widened constraint accepts them
 * all (migration 111 wrote the current definition).
 */

const EVENT_TYPES = [
  'charge_created', 'payment_recorded', 'status_changed', 'adjustment',
  'recurring_payment', 'failed_billing',
];

/** MySQL: ER_CHECK_CONSTRAINT_NOT_FOUND — the only error a DROP CHECK may swallow. */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const dropCheckIfExists = (knex, sql) =>
  knex.raw(sql).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });

/** The values the constraint currently lists, in the order MySQL prints them. */
const currentTypes = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND CONSTRAINT_NAME = 'billing_events_event_type_check'`,
  );
  const clause = rows[0]?.clause;
  if (clause == null) return null;
  return [...String(clause).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
};

// DDL is not transactional, so DROP + ADD leaves a window in which the column
// has *no* CHECK at all. Reading the current clause first makes the pair a
// no-op once it is already right, so a re-run after a crash between the two
// statements (which knex would not have recorded) costs nothing and, more
// importantly, does not re-open that window.
const setCheck = async (knex, types) => {
  const wanted = [...types].sort();
  const current = await currentTypes(knex);
  if (current != null && current.length === wanted.length && current.every((v, i) => v === wanted[i])) return;
  await dropCheckIfExists(knex, 'ALTER TABLE billing_events DROP CHECK billing_events_event_type_check');
  await knex.raw(
    'ALTER TABLE billing_events ADD CONSTRAINT billing_events_event_type_check ' +
    `CHECK (event_type IN (${types.map((v) => `'${v}'`).join(',')}))`,
  );
};

exports.up = async (knex) => {
  await setCheck(knex, [...EVENT_TYPES, 'waived_billing']);
};

exports.down = async (knex) => {
  // Narrowing the CHECK fails once a waived row exists, and a swallowed failure
  // would leave the column with *no* constraint at all (migration 165's own
  // lesson) — so decide first, and keep the widened CHECK when the ledger
  // already holds rows the narrow one would reject. The ledger is append-only:
  // deleting them to make the constraint fit is never the right trade.
  const [[{ n }]] = await knex.raw(
    "SELECT COUNT(*) AS n FROM billing_events WHERE event_type = 'waived_billing'",
  );
  if (Number(n) > 0) {
    console.warn(
      `[185] ${n} waived_billing billing_events row(s) exist — keeping the widened CHECK; ` +
      'the API build that writes them must be rolled back before this constraint can narrow.',
    );
    return;
  }
  await setCheck(knex, EVENT_TYPES);
};
