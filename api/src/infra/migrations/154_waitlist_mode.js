/**
 * #503 stage 2: make the waitlist configurable instead of unconditional.
 *
 * Until now any booking attempt past capacity was silently turned into a
 * waitlist row (api/src/api/bookings.ts's bookMemberOnSession) — there was no
 * way to turn that off. The issue thread's agreed model is a three-state
 * setting: 'disabled' (no waitlist at all), 'open' (accepting) and 'closed'
 * (enabled but not accepting right now).
 *
 * The setting lives on activity_types (where the thread says it is
 * configured) with a nullable per-occurrence override on calendar_events,
 * mirroring the existing capacity fallback — ce.capacity falls back to
 * at.max_capacity, so ce.waitlist_mode falls back to at.waitlist_mode.
 *
 * Default: the thread asks for the waitlist to be disabled by default, so
 * activity types created from here on start at 'disabled'. Rows that already
 * exist must land on 'open' instead — they were created under the old
 * unconditional-waitlist behavior, and silently rejecting their members'
 * over-capacity bookings would be a behavior change no admin asked for.
 *
 * That is done by adding the column with DEFAULT 'open' (one atomic DDL fills
 * every existing row) and only then flipping the default to 'disabled', rather
 * than adding it as 'disabled' plus a separate UPDATE: MySQL commits the
 * ADD COLUMN implicitly, so an abort between the two would strand every
 * existing activity type at 'disabled' with no way to tell those rows apart
 * from ones an admin deliberately set that way. Each step here is guarded on
 * the state it produces, so any interrupted run is repaired by re-running.
 *
 * Note this makes 153 lossy to roll back once live: down() drops the column,
 * so a later re-apply resets every admin-chosen mode to the defaults above.
 *
 * Follows the string + guarded CHECK convention used since ~080 (see
 * 152_calendar_events_drop_kind.js and 108_activity_type_schedule_rules.js's
 * nullable `IS NULL OR ... IN (...)` variant) rather than a native ENUM.
 * Adding an enforced CHECK rebuilds the table in MySQL 8 and blocks concurrent
 * DML, so the calendar_events step below is the slow one to expect on a large
 * instance. Columns are appended (no `.after(...)`) to stay eligible for
 * ALGORITHM=INSTANT — see 149_user_membership_promotions_snapshot.js.
 */

const MODES = "('disabled','open','closed')";

async function hasConstraint(knex, table, name) {
  const [[{ cnt }]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return Number(cnt) > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('activity_types', 'waitlist_mode'))) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.string('waitlist_mode', 20).notNullable().defaultTo('open');
    });
  }

  const [[currentDefault]] = await knex.raw(
    `SELECT COLUMN_DEFAULT AS d FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'activity_types'
       AND COLUMN_NAME = 'waitlist_mode'`,
  );
  if (currentDefault && currentDefault.d === 'open') {
    await knex.raw("ALTER TABLE activity_types ALTER COLUMN waitlist_mode SET DEFAULT 'disabled'");
  }

  if (!(await hasConstraint(knex, 'activity_types', 'chk_at_waitlist_mode'))) {
    await knex.raw(
      `ALTER TABLE activity_types ADD CONSTRAINT chk_at_waitlist_mode
       CHECK (waitlist_mode IN ${MODES})`,
    );
  }

  if (!(await knex.schema.hasColumn('calendar_events', 'waitlist_mode'))) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.string('waitlist_mode', 20).nullable();
    });
  }

  if (!(await hasConstraint(knex, 'calendar_events', 'chk_ce_waitlist_mode'))) {
    await knex.raw(
      `ALTER TABLE calendar_events ADD CONSTRAINT chk_ce_waitlist_mode
       CHECK (waitlist_mode IS NULL OR waitlist_mode IN ${MODES})`,
    );
  }
};

exports.down = async (knex) => {
  // CHECKs must go before their column — MySQL rejects DROP COLUMN otherwise.
  if (await hasConstraint(knex, 'calendar_events', 'chk_ce_waitlist_mode')) {
    await knex.raw('ALTER TABLE calendar_events DROP CHECK chk_ce_waitlist_mode');
  }
  if (await knex.schema.hasColumn('calendar_events', 'waitlist_mode')) {
    await knex.schema.alterTable('calendar_events', (t) => t.dropColumn('waitlist_mode'));
  }

  if (await hasConstraint(knex, 'activity_types', 'chk_at_waitlist_mode')) {
    await knex.raw('ALTER TABLE activity_types DROP CHECK chk_at_waitlist_mode');
  }
  if (await knex.schema.hasColumn('activity_types', 'waitlist_mode')) {
    await knex.schema.alterTable('activity_types', (t) => t.dropColumn('waitlist_mode'));
  }
};
