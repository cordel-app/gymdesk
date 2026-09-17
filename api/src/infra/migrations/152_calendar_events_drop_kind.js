/**
 * #503 stage 1: remove the session/event distinction entirely. Every
 * calendar_events row is now equally bookable — kind was the discriminator
 * that let classSessionsRouter/calendarEventsRouter and bookMemberOnSession
 * branch behavior by occurrence type (see migrations 134_calendar_events_stage3_gaps
 * and 134_calendar_events_unification_gaps). Per the issue thread's confirmed
 * resolution, that split is removed rather than extended.
 *
 * Two independently-guarded CHECK constraints exist on kind today
 * (chk_ce_kind from stage3_gaps, chk_calendar_events_kind from
 * unification_gaps — the latter migration re-added a differently-named
 * constraint because its own guard checked only its own name). Both must be
 * dropped before the column, or MySQL rejects the DROP COLUMN while a CHECK
 * still references it.
 *
 * Every step is guarded independently — DDL is non-transactional in MySQL.
 */

exports.up = async (knex) => {
  for (const constraintName of ['chk_ce_kind', 'chk_calendar_events_kind']) {
    const [[{ cnt }]] = await knex.raw(
      `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_events'
         AND CONSTRAINT_NAME = ?`,
      [constraintName],
    );
    if (Number(cnt) > 0) {
      await knex.raw(`ALTER TABLE calendar_events DROP CHECK ${constraintName}`);
    }
  }

  if (await knex.schema.hasColumn('calendar_events', 'kind')) {
    await knex.schema.alterTable('calendar_events', (t) => t.dropColumn('kind'));
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('calendar_events', 'kind'))) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.string('kind', 10).notNullable().defaultTo('event').after('center_id');
    });
  }

  const [[{ cnt }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_events'
       AND CONSTRAINT_NAME = 'chk_ce_kind'`,
  );
  if (Number(cnt) === 0) {
    await knex.raw(
      "ALTER TABLE calendar_events ADD CONSTRAINT chk_ce_kind CHECK (kind IN ('session','event'))",
    );
  }

  await knex.raw(
    "UPDATE calendar_events SET kind = 'session' WHERE schedule_rule_id IS NOT NULL AND kind <> 'session'",
  );
};
