/**
 * #2480 — Cancel a pending Billing Event and refund a collected one.
 *
 * 1. `billing_events.cancelled_at` / `cancelled_by`: a cancelled event is a
 *    terminal state recorded beside the row, never a deletion. It is a column
 *    and not a new `event_type` because a pending event may be a
 *    `product_purchase` (no ProductSet), which `chk_billing_events_product_set`
 *    only admits under its own type. The derived status reads it
 *    (`deriveBillingEventStatus()`).
 *
 * 2. `payment_requests.transaction_type` (`payment` | `refund`, CHECK) +
 *    `refund_of_payment_request_id` + `provider_refund_ref`: a refund is its own
 *    Payment Transaction, linked to the payment attempt it returns money from.
 *    A refund row carries **no** `billing_event_id`: every reader of "the
 *    event's latest attempt" (the derived status, the attempt counter, the
 *    charge guard, the payment method snapshot) filters on that column, so a
 *    refund can never be read as an attempt to settle the event. It reaches its
 *    event through the original attempt.
 *
 * 3. `payment_refund_lines`: which Billing Event line each Selected Line Items
 *    refund returned and how much, so a line is never refunded twice.
 *
 * 4. Feature flag `payments.billing_events.refund`, seeded enabled.
 *
 * "A refund names its original attempt and no event" cannot sit in the CHECK:
 * both columns are in an FK referential action (MySQL error 3823), so the one
 * writer (`api/src/api/billing-event-refunds.ts`) keeps it.
 *
 * `fk_payment_requests_refund_of` is ON DELETE CASCADE on purpose: a RESTRICT
 * self-FK breaks a plain bulk `DELETE FROM payment_requests` (test cleanup, the
 * dev billing reset), and no route hard-deletes a completed attempt, which is
 * the only kind a refund can name. `provider_refund_ref` is not UNIQUE: Monei's
 * refund reference is the payment id, shared by every partial refund of it.
 *
 * `down()` deletes every refund row: it is for dev only, never a rollback on
 * an environment holding real refunds.
 *
 * Nothing is backfilled: every existing row is a `payment` and no event is
 * cancelled. Cost: `ADD CONSTRAINT … CHECK` rebuilds `payment_requests` under
 * ALGORITHM=COPY (same window as migration 271).
 */

const hasCol = (knex, t, c) => knex.schema.hasColumn(t, c);
const CHECK = 'chk_payment_requests_transaction_type';

exports.up = async (knex) => {
  if (!(await hasCol(knex, 'billing_events', 'cancelled_at'))) {
    await knex.raw(`ALTER TABLE billing_events
      ADD COLUMN cancelled_at DATETIME NULL,
      ADD COLUMN cancelled_by VARCHAR(255) NULL`);
  }

  if (!(await hasCol(knex, 'payment_requests', 'transaction_type'))) {
    await knex.raw(`ALTER TABLE payment_requests
      ADD COLUMN transaction_type VARCHAR(10) NOT NULL DEFAULT 'payment',
      ADD COLUMN refund_of_payment_request_id INT UNSIGNED NULL,
      ADD COLUMN provider_refund_ref VARCHAR(255) NULL,
      ADD INDEX idx_payment_requests_refund_of (refund_of_payment_request_id),
      ADD CONSTRAINT fk_payment_requests_refund_of FOREIGN KEY (refund_of_payment_request_id)
        REFERENCES payment_requests (id) ON DELETE CASCADE`);
  }
  const [[c]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_requests' AND CONSTRAINT_NAME = ?`, [CHECK]);
  if (Number(c.cnt) === 0) {
    await knex.raw(`ALTER TABLE payment_requests ADD CONSTRAINT ${CHECK}
      CHECK (transaction_type IN ('payment', 'refund'))`);
  }

  if (!(await knex.schema.hasTable('payment_refund_lines'))) {
    await knex.raw(`CREATE TABLE payment_refund_lines (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      gym_id CHAR(36) NOT NULL,
      payment_request_id INT UNSIGNED NOT NULL,
      billing_event_line_id INT UNSIGNED NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
      created_by VARCHAR(255) NULL,
      UNIQUE KEY uq_prl_refund_line (payment_request_id, billing_event_line_id),
      KEY idx_prl_line (billing_event_line_id),
      CONSTRAINT fk_prl_gym FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
      CONSTRAINT fk_prl_refund FOREIGN KEY (payment_request_id) REFERENCES payment_requests (id) ON DELETE CASCADE,
      CONSTRAINT fk_prl_line FOREIGN KEY (billing_event_line_id) REFERENCES billing_event_lines (id) ON DELETE CASCADE,
      CONSTRAINT chk_prl_amount CHECK (amount > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  await knex.raw(
    `INSERT IGNORE INTO feature_flags (feature_key, enabled)
     VALUES ('payments.billing_events.refund', 1)`);
};

exports.down = async (knex) => {
  await knex.raw("DELETE FROM feature_flags WHERE feature_key = 'payments.billing_events.refund'");
  await knex.raw('DROP TABLE IF EXISTS payment_refund_lines');
  await knex.raw("DELETE FROM payment_requests WHERE transaction_type = 'refund'");
  const [[d]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_requests' AND CONSTRAINT_NAME = ?`, [CHECK]);
  if (Number(d.cnt) > 0) await knex.raw(`ALTER TABLE payment_requests DROP CHECK ${CHECK}`);
  if (await hasCol(knex, 'payment_requests', 'transaction_type')) {
    await knex.raw(`ALTER TABLE payment_requests
      DROP FOREIGN KEY fk_payment_requests_refund_of,
      DROP INDEX idx_payment_requests_refund_of,
      DROP COLUMN provider_refund_ref, DROP COLUMN refund_of_payment_request_id, DROP COLUMN transaction_type`);
  }
  if (await hasCol(knex, 'billing_events', 'cancelled_at')) {
    await knex.raw('ALTER TABLE billing_events DROP COLUMN cancelled_by, DROP COLUMN cancelled_at');
  }
};
