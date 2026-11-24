/**
 * #3284 stage 1 — `billing_event_line_reasons`: every treatment that explains a Billing Event Line's
 * amount, one row each, in the order the engine applied them.
 *
 * `billing_event_lines.treatment_action` / `treatment_value` / `promotion_name` hold one primary
 * treatment, so a line a Plan benefit and a Direct Discount (%) both priced kept only one of them.
 * A reason is classified once, by `lineReasons()` (`domain/billingEventLines.ts`), from the engine's
 * own source and explicit evidence: `reason_type` is `benefit` (the Membership Plan's own treatment),
 * `discount` (an applied Promotion) or `manual_adjustment` (a Direct Discount, the Personal Membership
 * Fee Benefit; stage 2 adds the Initial Payment waive, reason_code `initial_payment_waive`).
 * Written only by `writeEventLines()` with its line, never rewritten; it cascades with the line.
 *
 * `reason_code` is deliberately free text (no CHECK): it is the manual adjustment's explicit
 * evidence and stage 2 adds `initial_payment_waive` without a table rebuild. `action` is the
 * Promotion vocabulary minus `no_benefit` (which `lineReasons()` never writes).
 *
 * No backfill: a historical line's other treatments were never stored, so its reasons cannot be
 * reconstructed; it keeps its single primary treatment on the line row.
 */
const TABLE = 'billing_event_line_reasons';

exports.up = async (knex) => {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.raw(`
    CREATE TABLE ${TABLE} (
      id                    INT UNSIGNED  NOT NULL AUTO_INCREMENT,
      gym_id                CHAR(36)      NOT NULL,
      billing_event_line_id INT UNSIGNED  NOT NULL,
      position              SMALLINT UNSIGNED NOT NULL,
      reason_type           VARCHAR(20)   NOT NULL,
      source                VARCHAR(20)   NOT NULL,
      reason_code           VARCHAR(40)   NULL,
      action                VARCHAR(30)   NOT NULL,
      value                 DECIMAL(10,2) NULL,
      name                  VARCHAR(255)  NULL,
      created_at            DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
      PRIMARY KEY (id),
      UNIQUE KEY belr_line_position_unique (billing_event_line_id, position),
      KEY belr_gym_index (gym_id),
      CONSTRAINT belr_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE,
      CONSTRAINT belr_line_fk FOREIGN KEY (billing_event_line_id) REFERENCES billing_event_lines (id) ON DELETE CASCADE,
      CONSTRAINT chk_belr_type CHECK (reason_type IN ('benefit', 'discount', 'manual_adjustment')),
      CONSTRAINT chk_belr_source CHECK (source IN ('membership_plan', 'promotion', 'personal')),
      CONSTRAINT chk_belr_action CHECK (action IN ('waive', 'percentage_discount', 'fixed_discount', 'fixed_price')),
      CONSTRAINT chk_belr_position CHECK (position > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
};
