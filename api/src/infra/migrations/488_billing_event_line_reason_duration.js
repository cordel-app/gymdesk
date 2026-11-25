/**
 * #3282 follow-up — a Promotion reason states how long the Promotion lasts:
 * `Promotion: Todos los productos al 50% (3 months)`.
 *
 * `duration_count` + `duration_unit` are the reason's `duration` (`SimulationBenefit.duration`,
 * `lineReasons()`): a periodical grant's own Duration in the Product's billing periods (#1135), or a
 * Membership Fee benefit's Promotion Free + Paid + Bonus months. Written only by `writeEventLines()`
 * with the reason, never rewritten. Both NULL for every other reason.
 *
 * No backfill: a reason written before this migration did not record its Promotion's duration as it
 * was agreed, and the live Promotion is not the record of it (#635 §16), so it keeps reading its name
 * alone.
 */
const TABLE = 'billing_event_line_reasons';

exports.up = async (knex) => {
  if (await knex.schema.hasColumn(TABLE, 'duration_count')) return;
  await knex.raw(`
    ALTER TABLE ${TABLE}
      ADD COLUMN duration_count SMALLINT UNSIGNED NULL AFTER name,
      ADD COLUMN duration_unit  VARCHAR(20)       NULL AFTER duration_count,
      ADD CONSTRAINT chk_belr_duration CHECK (
        (duration_count IS NULL AND duration_unit IS NULL)
        OR (duration_count > 0 AND duration_unit IN ('week', 'four_weeks', 'month', 'year'))
      )
  `);
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, 'duration_count'))) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CHECK chk_belr_duration, DROP COLUMN duration_unit, DROP COLUMN duration_count`);
};
