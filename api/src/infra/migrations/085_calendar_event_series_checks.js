/**
 * #191: Add missing CHECK constraints on monthly_ordinal and monthly_weekday
 * in calendar_event_series (083 was deployed without them on already-migrated instances).
 */
exports.up = async (knex) => {
  const [[{ cnt: cntOrdinal }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_series'
       AND CONSTRAINT_NAME = 'chk_ces_monthly_ordinal'`,
  );
  if (cntOrdinal === 0) {
    await knex.raw(
      "ALTER TABLE calendar_event_series ADD CONSTRAINT chk_ces_monthly_ordinal " +
      "CHECK (monthly_ordinal IS NULL OR monthly_ordinal IN ('first','second','third','fourth','last'))",
    );
  }

  const [[{ cnt: cntWeekday }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_event_series'
       AND CONSTRAINT_NAME = 'chk_ces_monthly_weekday'`,
  );
  if (cntWeekday === 0) {
    await knex.raw(
      "ALTER TABLE calendar_event_series ADD CONSTRAINT chk_ces_monthly_weekday " +
      "CHECK (monthly_weekday IS NULL OR monthly_weekday IN ('Mon','Tue','Wed','Thu','Fri','Sat','Sun'))",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE calendar_event_series DROP CHECK chk_ces_monthly_ordinal').catch(() => {});
  await knex.raw('ALTER TABLE calendar_event_series DROP CHECK chk_ces_monthly_weekday').catch(() => {});
};
