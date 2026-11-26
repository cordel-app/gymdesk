/**
 * #3445 (stage 2) — a Billing Event Line records the schedule and the period it bills.
 *
 * The rolling window now keeps the next two future positive Billing Event dates of a Product Set
 * across all its schedules, and the obligations of different schedules that fall on one date are
 * consolidated into ONE Scheduled Billing Event. The event row can name one schedule only
 * (`billing_events.schedule_id`, still `UNIQUE (schedule_id, period_start)`), so the identity of each
 * line's own obligation is kept on the line: `schedule_id` (SET NULL, like every other schedule
 * reference) plus `period_start` / `period_end`. Written only by `writeEventLines()` for a line
 * `materialiseScheduledEvents()` persists, never rewritten; NULL on every other line.
 *
 * The FK makes MySQL rebuild the table (ALGORITHM=COPY, writes blocked while it runs); accepted as
 * migrations 168/170/174/189 did — the statement stays one, so the `hasColumn` guard covers it whole.
 *
 * No backfill: an event written before this migration holds one schedule's lines, whose identity is
 * the event's own `(schedule_id, period_start)`, which the readers keep asking.
 */
const TABLE = 'billing_event_lines';

exports.up = async (knex) => {
  if (await knex.schema.hasColumn(TABLE, 'schedule_id')) return;
  await knex.raw(`
    ALTER TABLE ${TABLE}
      ADD COLUMN schedule_id  INT UNSIGNED NULL AFTER line_key,
      ADD COLUMN period_start DATE NULL AFTER schedule_id,
      ADD COLUMN period_end   DATE NULL AFTER period_start,
      ADD KEY bel_schedule_period_idx (schedule_id, period_start),
      ADD CONSTRAINT bel_schedule_fk FOREIGN KEY (schedule_id) REFERENCES product_set_schedules (id) ON DELETE SET NULL
  `);
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, 'schedule_id'))) return;
  await knex.raw(`
    ALTER TABLE ${TABLE}
      DROP FOREIGN KEY bel_schedule_fk,
      DROP KEY bel_schedule_period_idx,
      DROP COLUMN period_end, DROP COLUMN period_start, DROP COLUMN schedule_id
  `);
};
