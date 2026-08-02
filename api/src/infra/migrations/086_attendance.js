/**
 * #193 — Attendance Management.
 *
 * bookings:
 *   - Add attendance_status ('pending'|'present'|'absent') separate from booking lifecycle.
 *   - Add attendance_recorded_at / attendance_recorded_by_membership_id for audit.
 *   - Backfill: existing status='attended' → attendance_status='present', status='booked';
 *               existing status='no_show' → attendance_status='absent', status='booked'.
 *   - Drop and recreate bookings_status_check without 'attended' and 'no_show'.
 *
 * class_sessions:
 *   - Add effective_trainer_membership_id — who actually delivered the session.
 *   - Add effective_trainer_confirmed_at — when that was recorded.
 *
 * All ALTERs are guarded with hasColumn / information_schema checks.
 */

exports.up = async (knex) => {
  // ── bookings ────────────────────────────────────────────────────────────

  const hasCol = (col) => knex.schema.hasColumn('bookings', col);

  if (!(await hasCol('attendance_status'))) {
    await knex.schema.alterTable('bookings', (t) => {
      t.string('attendance_status', 20).notNullable().defaultTo('pending');
    });
  }
  if (!(await hasCol('attendance_recorded_at'))) {
    await knex.schema.alterTable('bookings', (t) => {
      t.datetime('attendance_recorded_at');
    });
  }
  if (!(await hasCol('attendance_recorded_by_membership_id'))) {
    await knex.schema.alterTable('bookings', (t) => {
      t.integer('attendance_recorded_by_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }

  // Backfill attendance_status from the old conflated status values.
  await knex.raw(
    "UPDATE bookings SET attendance_status = 'present' WHERE status = 'attended' AND attendance_status = 'pending'",
  );
  await knex.raw(
    "UPDATE bookings SET attendance_status = 'absent'  WHERE status = 'no_show'  AND attendance_status = 'pending'",
  );

  // Migrate old status values to 'booked' now that attendance_status carries the info.
  await knex.raw(
    "UPDATE bookings SET status = 'booked' WHERE status IN ('attended', 'no_show')",
  );

  // Drop the old CHECK and recreate it without 'attended'/'no_show'.
  const [existingCheck] = await knex.raw(
    "SELECT 1 FROM information_schema.CHECK_CONSTRAINTS " +
    "WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'bookings_status_check'",
  );
  if (existingCheck.length > 0) {
    await knex.raw('ALTER TABLE bookings DROP CHECK bookings_status_check');
  }
  await knex.raw(
    "ALTER TABLE bookings ADD CONSTRAINT bookings_status_check " +
    "CHECK (status IN ('booked','waitlisted','cancelled'))",
  );

  // Add CHECK for attendance_status.
  const [attCheck] = await knex.raw(
    "SELECT 1 FROM information_schema.CHECK_CONSTRAINTS " +
    "WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_bookings_attendance_status'",
  );
  if (attCheck.length === 0) {
    await knex.raw(
      "ALTER TABLE bookings ADD CONSTRAINT chk_bookings_attendance_status " +
      "CHECK (attendance_status IN ('pending','present','absent'))",
    );
  }

  // ── class_sessions ───────────────────────────────────────────────────────

  const hasCsCol = (col) => knex.schema.hasColumn('class_sessions', col);

  if (!(await hasCsCol('effective_trainer_membership_id'))) {
    await knex.schema.alterTable('class_sessions', (t) => {
      t.integer('effective_trainer_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
    });
  }
  if (!(await hasCsCol('effective_trainer_confirmed_at'))) {
    await knex.schema.alterTable('class_sessions', (t) => {
      t.datetime('effective_trainer_confirmed_at');
    });
  }
};

exports.down = async (knex) => {
  // 1. Swap CHECK constraints FIRST so the old status values become valid again.
  await knex.raw('ALTER TABLE bookings DROP CHECK bookings_status_check').catch(() => {});
  await knex.raw('ALTER TABLE bookings DROP CHECK chk_bookings_attendance_status').catch(() => {});
  await knex.raw(
    "ALTER TABLE bookings ADD CONSTRAINT bookings_status_check " +
    "CHECK (status IN ('booked','waitlisted','cancelled','attended','no_show'))",
  ).catch(() => {});

  // 2. Restore old status values — constraint now permits them.
  //    No IS NOT NULL guard: backfilled rows have attendance_recorded_at = NULL.
  await knex.raw(
    "UPDATE bookings SET status = 'attended' WHERE status = 'booked' AND attendance_status = 'present'",
  ).catch(() => {});
  await knex.raw(
    "UPDATE bookings SET status = 'no_show'  WHERE status = 'booked' AND attendance_status = 'absent'",
  ).catch(() => {});

  // 3. Drop FK constraints before their columns (MySQL requires this).
  if (await knex.schema.hasColumn('bookings', 'attendance_recorded_by_membership_id')) {
    await knex.raw('ALTER TABLE bookings DROP FOREIGN KEY bookings_attendance_recorded_by_membership_id_foreign').catch(() => {});
    await knex.schema.alterTable('bookings', (t) => t.dropColumn('attendance_recorded_by_membership_id'));
  }
  for (const col of ['attendance_status', 'attendance_recorded_at']) {
    if (await knex.schema.hasColumn('bookings', col)) {
      await knex.schema.alterTable('bookings', (t) => t.dropColumn(col));
    }
  }

  if (await knex.schema.hasColumn('class_sessions', 'effective_trainer_membership_id')) {
    await knex.raw('ALTER TABLE class_sessions DROP FOREIGN KEY class_sessions_effective_trainer_membership_id_foreign').catch(() => {});
    await knex.schema.alterTable('class_sessions', (t) => t.dropColumn('effective_trainer_membership_id'));
  }
  if (await knex.schema.hasColumn('class_sessions', 'effective_trainer_confirmed_at')) {
    await knex.schema.alterTable('class_sessions', (t) => t.dropColumn('effective_trainer_confirmed_at'));
  }
};
