/**
 * #2935 — Refund Receipts.
 *
 * A Refund Receipt documents money returned by one **completed** refund
 * Payment Transaction (`payment_requests.transaction_type = 'refund'`, #2480).
 * It is a document of its own: the original receipt (`billing_events.
 * receipt_number`) and every invoice are never touched.
 *
 * 1. `refund_receipt_sequences`: the Refund Receipts' own gapless series, per
 *    gym and calendar year, beside (never inside) `receipt_sequences`.
 *
 * 2. `refund_receipts`: one row per refund transaction
 *    (`UNIQUE (payment_request_id)`, so a refund is documented at most once),
 *    naming the original payment attempt it returned money from and the Billing
 *    Event, with its number (`UNIQUE (gym_id, receipt_number)`), the moment it
 *    was issued and, once rendered into the private bucket, the PDF's key.
 *
 * The FKs to `payment_requests` and `billing_events` are ON DELETE CASCADE for
 * the reason migration 386 gives for `fk_payment_requests_refund_of`: no route
 * hard-deletes a completed attempt, and a RESTRICT FK would break the dev
 * billing reset's plain `DELETE FROM payment_requests` and test cleanup.
 *
 * Nothing is backfilled: refunds completed before this migration have no
 * receipt (the ticket asks for one on each refund from now on).
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('refund_receipt_sequences'))) {
    await knex.raw(`CREATE TABLE refund_receipt_sequences (
      gym_id CHAR(36) NOT NULL,
      year SMALLINT UNSIGNED NOT NULL,
      last_seq INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (gym_id, year),
      CONSTRAINT fk_rrs_gym FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  if (!(await knex.schema.hasTable('refund_receipts'))) {
    await knex.raw(`CREATE TABLE refund_receipts (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      gym_id CHAR(36) NOT NULL,
      payment_request_id INT UNSIGNED NOT NULL,
      original_payment_request_id INT UNSIGNED NOT NULL,
      billing_event_id INT UNSIGNED NOT NULL,
      receipt_number VARCHAR(32) NOT NULL,
      issued_at DATETIME NOT NULL,
      pdf_key VARCHAR(512) NULL,
      created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
      created_by VARCHAR(255) NULL,
      UNIQUE KEY uq_refund_receipts_refund (payment_request_id),
      UNIQUE KEY uq_refund_receipts_number (gym_id, receipt_number),
      KEY idx_refund_receipts_event (billing_event_id),
      KEY idx_refund_receipts_original (original_payment_request_id),
      CONSTRAINT fk_rr_gym FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
      CONSTRAINT fk_rr_refund FOREIGN KEY (payment_request_id) REFERENCES payment_requests (id) ON DELETE CASCADE,
      CONSTRAINT fk_rr_original FOREIGN KEY (original_payment_request_id) REFERENCES payment_requests (id) ON DELETE CASCADE,
      CONSTRAINT fk_rr_event FOREIGN KEY (billing_event_id) REFERENCES billing_events (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE IF EXISTS refund_receipts');
  await knex.raw('DROP TABLE IF EXISTS refund_receipt_sequences');
};
