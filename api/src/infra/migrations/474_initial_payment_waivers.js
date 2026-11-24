/**
 * #3284 stage 2 — the staff per-line Initial Payment waive.
 *
 * `initial_payment_waivers`: one row per waived line of a cart's Initial Payment, keyed by the cart
 * (`purchases`, #3251) and the line's stable identity (`line_key`, `initialPaymentLineKeys()` in
 * `domain/initialPaymentWaiver.ts`). The row is the whole waiver: `initialCharge()` applies it to
 * the line after the engine priced it, so the plan, its Promotions, its direct discounts and every
 * recurring obligation are untouched. Reverting deletes the row. A row whose line no longer exists
 * applies to nothing; a cart merged into another (`syncPurchase()`) brings its waivers along, and a deleted
 * cart takes its own (cascade). Written
 * only by `api/initial-payment-waivers.ts`; the actor is the audit row's (`waive_initial_payment_line`
 * / `revert_initial_payment_waive` on the Product Set), so the table carries no actor column.
 *
 * `billing_event_lines.line_key`: the same identity, written by `writeEventLines()` on the initial
 * event's lines, so the line previewed and the line persisted are one. NULL on every other line
 * (scheduled obligations, purchases outside a Product Set, history): no backfill.
 */
const TABLE = 'initial_payment_waivers';

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id      CHAR(36)     NOT NULL,
        purchase_id INT UNSIGNED NOT NULL,
        line_key    VARCHAR(120) NOT NULL,
        created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY ipw_purchase_line_unique (purchase_id, line_key),
        KEY ipw_gym_index (gym_id),
        CONSTRAINT ipw_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
        CONSTRAINT ipw_purchase_fk FOREIGN KEY (purchase_id) REFERENCES purchases (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }
  if (!(await knex.schema.hasColumn('billing_event_lines', 'line_key'))) {
    await knex.raw('ALTER TABLE billing_event_lines ADD COLUMN line_key VARCHAR(120) NULL, ALGORITHM=INSTANT');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('billing_event_lines', 'line_key')) {
    await knex.raw('ALTER TABLE billing_event_lines DROP COLUMN line_key');
  }
  await knex.schema.dropTableIfExists(TABLE);
};
