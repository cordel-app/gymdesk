/**
 * #2451 — a Payment Transaction (`payment_requests` row) keeps an immutable
 * snapshot of the payment method it was made with, and the Billing Event owns
 * the attempt counter.
 *
 * Snapshot: `payment_method_code` + `payment_method_name` (English name, copied
 * from `base_payment_methods` when the attempt is created) and an optional
 * `base_payment_method_id` kept for traceability only (no FK: the display never
 * joins the catalogue, and a catalogue row may be soft-deleted or renamed).
 * Backfill is conservative: `cash` -> Cash, `card_terminal` -> Card, an online
 * provider attempt -> Monei (Members App when the member raised it). A waiver
 * and anything the data cannot identify stay NULL.
 *
 * Counter: `billing_events.attempt_count` is the total number of attempts. It
 * is backfilled as GREATEST(MAX(attempt), COUNT(*)) so history is never reset.
 * `payment_requests.attempt` stays as the attempt's own position (set from the
 * counter), but is no longer authoritative.
 */
const hasCol = (knex, t, c) => knex.schema.hasColumn(t, c);

exports.up = async (knex) => {
  if (!(await hasCol(knex, 'payment_requests', 'payment_method_name'))) {
    await knex.raw(`ALTER TABLE payment_requests
      ADD COLUMN base_payment_method_id INT UNSIGNED NULL,
      ADD COLUMN payment_method_code VARCHAR(50) NULL,
      ADD COLUMN payment_method_name VARCHAR(120) NULL`);
  }
  if (!(await hasCol(knex, 'billing_events', 'attempt_count'))) {
    await knex.raw('ALTER TABLE billing_events ADD COLUMN attempt_count INT UNSIGNED NOT NULL DEFAULT 0');
  }

  await knex.raw(`
    UPDATE billing_events be
      JOIN (SELECT billing_event_id, GREATEST(MAX(attempt), COUNT(*)) AS n
              FROM payment_requests WHERE billing_event_id IS NOT NULL GROUP BY billing_event_id) a
        ON a.billing_event_id = be.id
       SET be.attempt_count = a.n
     WHERE be.attempt_count < a.n`);

  await knex.raw(`
    UPDATE payment_requests pr
      JOIN base_payment_methods m ON m.deleted_at IS NULL AND m.code = CASE
             WHEN pr.method = 'cash' THEN 'cash'
             WHEN pr.method = 'card_terminal' THEN 'card'
             WHEN pr.method = 'provider' AND pr.source IN ('customer','product_purchase') THEN 'members_app'
             WHEN pr.method = 'provider' AND pr.provider = 'monei' THEN 'monei'
             ELSE NULL END
      JOIN base_payment_method_translations t ON t.base_payment_method_id = m.id AND t.locale = 'en'
       SET pr.base_payment_method_id = m.id, pr.payment_method_code = m.code, pr.payment_method_name = t.name
     WHERE pr.payment_method_name IS NULL`);
};

exports.down = async (knex) => {
  if (await hasCol(knex, 'billing_events', 'attempt_count')) {
    await knex.raw('ALTER TABLE billing_events DROP COLUMN attempt_count');
  }
  if (await hasCol(knex, 'payment_requests', 'payment_method_name')) {
    await knex.raw(`ALTER TABLE payment_requests
      DROP COLUMN payment_method_name, DROP COLUMN payment_method_code, DROP COLUMN base_payment_method_id`);
  }
};
