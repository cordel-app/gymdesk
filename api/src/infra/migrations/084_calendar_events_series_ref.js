/**
 * #191: Add series_id and series_occurrence_date to calendar_events so each
 * generated occurrence knows which series it belongs to and what its canonical
 * scheduled date is (survives drag-and-drop moves).
 */
exports.up = async (knex) => {
  const hasSeriesId = await knex.schema.hasColumn('calendar_events', 'series_id');
  if (!hasSeriesId) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.integer('series_id').unsigned().nullable()
        .references('id').inTable('calendar_event_series').onDelete('SET NULL');
    });
  }

  const hasOccurrenceDate = await knex.schema.hasColumn('calendar_events', 'series_occurrence_date');
  if (!hasOccurrenceDate) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.date('series_occurrence_date').nullable();
    });
  }

  // Index for series-scoped queries (find all events for a series, or after a date)
  const [[{ cnt }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_events'
       AND INDEX_NAME = 'calendar_events_series_idx'`,
  );
  if (cnt === 0) {
    await knex.raw(
      'ALTER TABLE calendar_events ADD INDEX calendar_events_series_idx (series_id, series_occurrence_date)',
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE calendar_events DROP INDEX calendar_events_series_idx').catch(() => {});

  const hasOccurrenceDate = await knex.schema.hasColumn('calendar_events', 'series_occurrence_date');
  if (hasOccurrenceDate) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.dropColumn('series_occurrence_date');
    });
  }

  const hasSeriesId = await knex.schema.hasColumn('calendar_events', 'series_id');
  if (hasSeriesId) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.dropForeign(['series_id']);
      t.dropColumn('series_id');
    });
  }
};
