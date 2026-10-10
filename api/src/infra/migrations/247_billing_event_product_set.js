/**
 * #1325 PR 2a — the billing ledger learns its owner, its schedule and its lines.
 *
 * Additive and behaviour-neutral: no writer fills any of this yet (that is 2b)
 * and no reader reads it (2c/2d), so the live nightly run is untouched.
 *
 *   billing_events.product_set_id     the ProductSet version that originated the
 *                                     obligation. NULLable until PR 3 reset the
 *                                     legacy rows; then NOT NULL, with NULL
 *                                     allowed only for `product_purchase`.
 *   billing_events.schedule_id        the recurring schedule that produced it
 *                                     (NULL for a one-off). SET NULL: removing a
 *                                     schedule must never delete an obligation.
 *   billing_events.period_start/_end  the period the obligation covers.
 *   billing_events.billing_date       the due date.
 *   billing_events.is_scheduled       a persisted obligation not yet executed.
 *                                     Deliberately a boolean and not a lifecycle
 *                                     value: execution transitions the event
 *                                     straight to its provider status (derived
 *                                     from the latest attempt), and `WAIVED` is a
 *                                     payment method, not a state.
 *   UNIQUE (schedule_id, period_start) one obligation per schedule and period,
 *                                     across ProductSet versions (a NULL
 *                                     schedule — a one-off — never collides).
 *
 *   billing_event_lines               the priced components of one event, taken
 *                                     from the engine's own output. One event
 *                                     had one amount and one charge type; a
 *                                     composite obligation (plan + products +
 *                                     promotions) could not be explained.
 *
 *   payment_requests.provider_status  the provider's own status, verbatim and
 *                                     with no CHECK: an unknown status must be
 *                                     storable, never coerced to FAILED.
 *   payment_requests.method           `provider` | `cash` | `waive` — how a
 *                                     request was settled. Waive and cash create
 *                                     a request but no provider attempt.
 *
 * Deliberately NOT added here: `UNIQUE (billing_event_id, attempt)`. The ticket
 * asks for it only once it is validated against every retry flow, and it is not
 * compatible with today's: `findOpenInitialEvent()` links each new Pay-now
 * request to the same open event and every such row carries the column default
 * `attempt = 1`. It lands with the writer that numbers attempts (2c).
 *
 * The event-type CHECK gains `product_purchase` and `card_verification`.
 */

const BASE_TYPES = [
  'charge_created', 'payment_recorded', 'status_changed', 'adjustment',
  'recurring_payment', 'failed_billing', 'waived_billing',
];
const WIDENED = [...BASE_TYPES, 'product_purchase', 'card_verification'];

const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;
const dropCheckIfExists = (knex, sql) =>
  knex.raw(sql).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });

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
  if (!(await knex.schema.hasColumn('billing_events', 'product_set_id'))) {
    await knex.raw(`ALTER TABLE billing_events
      ADD COLUMN product_set_id INT UNSIGNED NULL,
      ADD COLUMN schedule_id    INT UNSIGNED NULL,
      ADD COLUMN period_start   DATE NULL,
      ADD COLUMN period_end     DATE NULL,
      ADD COLUMN billing_date   DATE NULL,
      ADD COLUMN is_scheduled   TINYINT(1) NOT NULL DEFAULT 0,
      ADD KEY billing_events_product_set_index (product_set_id, is_scheduled, billing_date),
      ADD UNIQUE KEY billing_events_schedule_period_key (schedule_id, period_start),
      ADD CONSTRAINT billing_events_product_set_fk FOREIGN KEY (product_set_id) REFERENCES product_sets (id) ON DELETE CASCADE,
      ADD CONSTRAINT billing_events_schedule_fk FOREIGN KEY (schedule_id) REFERENCES product_set_schedules (id) ON DELETE SET NULL`);
  }

  await setCheck(knex, WIDENED);

  if (!(await knex.schema.hasTable('billing_event_lines'))) {
    await knex.raw(`
      CREATE TABLE billing_event_lines (
        id                       INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        gym_id                   CHAR(36)      NOT NULL,
        billing_event_id         INT UNSIGNED  NOT NULL,
        kind                     VARCHAR(20)   NOT NULL,
        product_id               INT UNSIGNED  NULL,
        item_name                VARCHAR(255)  NOT NULL,
        item_type                VARCHAR(32)   NULL,
        quantity                 INT UNSIGNED  NOT NULL DEFAULT 1,
        regular_unit_price       DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        treatment_action         VARCHAR(30)   NOT NULL DEFAULT 'no_benefit',
        treatment_value          DECIMAL(10,2) NULL,
        promotion_application_id INT UNSIGNED  NULL,
        promotion_name           VARCHAR(255)  NULL,
        prorated_days            INT           NULL,
        period_days              INT           NULL,
        tax_rate_percent         DECIMAL(5,2)  NULL,
        tax_behavior             VARCHAR(20)   NULL,
        amount_excl_tax          DECIMAL(10,2) NULL,
        amount                   DECIMAL(10,2) NOT NULL,
        created_at               DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        KEY bel_event_index (billing_event_id),
        KEY bel_gym_index (gym_id),
        CONSTRAINT bel_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT bel_event_fk FOREIGN KEY (billing_event_id) REFERENCES billing_events (id) ON DELETE CASCADE,
        CONSTRAINT bel_product_fk FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL,
        CONSTRAINT bel_promotion_fk FOREIGN KEY (promotion_application_id) REFERENCES user_membership_promotions (id) ON DELETE SET NULL,
        CONSTRAINT chk_bel_kind CHECK (kind IN ('membership_fee','product','service','adjustment')),
        CONSTRAINT chk_bel_quantity CHECK (quantity > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  if (!(await knex.schema.hasColumn('payment_requests', 'provider_status'))) {
    await knex.raw(`ALTER TABLE payment_requests
      ADD COLUMN provider_status VARCHAR(40) NULL,
      ADD COLUMN method VARCHAR(20) NOT NULL DEFAULT 'provider'`);
    await knex.raw(`ALTER TABLE payment_requests
      ADD CONSTRAINT chk_payment_requests_method CHECK (method IN ('provider','cash','waive'))`);
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('billing_event_lines');
  if (await knex.schema.hasColumn('payment_requests', 'provider_status')) {
    await knex.raw('ALTER TABLE payment_requests DROP CHECK chk_payment_requests_method');
    await knex.raw('ALTER TABLE payment_requests DROP COLUMN provider_status, DROP COLUMN method');
  }
  if (await knex.schema.hasColumn('billing_events', 'product_set_id')) {
    await knex.raw(`ALTER TABLE billing_events
      DROP FOREIGN KEY billing_events_product_set_fk, DROP FOREIGN KEY billing_events_schedule_fk,
      DROP INDEX billing_events_schedule_period_key, DROP INDEX billing_events_product_set_index,
      DROP COLUMN product_set_id, DROP COLUMN schedule_id, DROP COLUMN period_start,
      DROP COLUMN period_end, DROP COLUMN billing_date, DROP COLUMN is_scheduled`);
  }
  const [[{ n }]] = await knex.raw(
    "SELECT COUNT(*) AS n FROM billing_events WHERE event_type IN ('product_purchase','card_verification')");
  if (Number(n) === 0) await setCheck(knex, BASE_TYPES);
};
