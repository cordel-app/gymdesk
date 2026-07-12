/**
 * P2.5 (#17): evolve bookings for waitlist + attendance, drop the legacy
 * class_id / classes surface.
 *
 * Additive columns first, then backfill class_session_id from the legacy
 * class_id via the (gym_id, name, starts_at, ends_at) key that P2.4 used to
 * generate sessions. Only THEN drop class_id and the classes table.
 *
 * Uniqueness — "one non-cancelled booking per member per session" — uses the
 * P1.5 generated-column pattern because MySQL has no partial unique indexes:
 *   active_booking_key = IF(status NOT IN ('cancelled'), member_id, NULL)
 * UNIQUE(class_session_id, active_booking_key). NULLs don't collide in unique
 * indexes, so cancelled rows are exempt.
 *
 * Idempotent: hasColumn() / hasTable() / duplicate-key guards make this
 * re-runnable against a partially-applied database.
 */

exports.up = async (knex) => {
  const has = (col) => knex.schema.hasColumn('bookings', col);

  if (!(await has('class_session_id'))) {
    await knex.schema.alterTable('bookings', (t) => {
      t.integer('class_session_id').unsigned()
        .references('id').inTable('class_sessions').onDelete('CASCADE');
    });
  }
  for (const [col, add] of [
    ['waitlist_position', (t) => t.integer('waitlist_position').unsigned()],
    ['booked_at',         (t) => t.datetime('booked_at')],
    ['waitlisted_at',     (t) => t.datetime('waitlisted_at')],
    ['cancelled_at',      (t) => t.datetime('cancelled_at')],
    ['attendance_confirmed_at', (t) => t.datetime('attendance_confirmed_at')],
    ['attendance_confirmed_by', (t) => t.string('attendance_confirmed_by', 64)],
  ]) {
    if (!(await has(col))) {
      await knex.schema.alterTable('bookings', add);
    }
  }

  // Backfill class_session_id from class_id → class_sessions match (P2.4 kept
  // starts_at/ends_at identical when it created each session).
  if (await has('class_id')) {
    await knex.raw(`
      UPDATE bookings b
      JOIN classes c ON c.id = b.class_id
      JOIN class_types ct ON ct.gym_id = b.gym_id AND ct.name = c.name
      JOIN class_sessions cs
        ON cs.class_type_id = ct.id
       AND cs.gym_id = b.gym_id
       AND cs.starts_at = c.starts_at
       AND cs.ends_at   = c.ends_at
      SET b.class_session_id = cs.id
      WHERE b.class_session_id IS NULL
    `);
  }

  // Normalise legacy statuses. Old set was ('confirmed','cancelled'); new set is
  // ('booked','waitlisted','cancelled','attended','no_show'). Map confirmed → booked.
  await knex.raw("UPDATE bookings SET status = 'booked' WHERE status = 'confirmed'");
  const [statusRow] = await knex.raw(
    "SELECT 1 FROM information_schema.CHECK_CONSTRAINTS " +
    "WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'bookings_status_check'",
  );
  if (statusRow.length === 0) {
    await knex.raw(
      "ALTER TABLE bookings ADD CONSTRAINT bookings_status_check " +
      "CHECK (status IN ('booked','waitlisted','cancelled','attended','no_show'))",
    );
  }

  // Backfill booked_at from created_at so downstream sorts don't see NULLs.
  await knex.raw("UPDATE bookings SET booked_at = created_at WHERE booked_at IS NULL AND status IN ('booked','attended','no_show')");

  // Drop the old class_id + classes table only once every row has a class_session_id.
  if (await has('class_id')) {
    const [orphans] = await knex.raw(
      'SELECT COUNT(*) AS n FROM bookings WHERE class_session_id IS NULL',
    );
    if (orphans[0].n > 0) {
      throw new Error(`${orphans[0].n} bookings could not be mapped to a class_session — investigate before dropping class_id`);
    }
    await knex.raw('ALTER TABLE bookings DROP FOREIGN KEY bookings_class_id_foreign').catch(() => {});
    await knex.schema.alterTable('bookings', (t) => t.dropColumn('class_id'));
  }
  if (await knex.schema.hasTable('classes')) {
    await knex.schema.dropTable('classes');
  }

  // Now that every row carries class_session_id, make it NOT NULL and add the
  // waitlist-aware unique index (generated column).
  await knex.raw('ALTER TABLE bookings MODIFY class_session_id INT UNSIGNED NOT NULL');

  if (!(await knex.schema.hasColumn('bookings', 'active_booking_key'))) {
    // VIRTUAL, not STORED — see 007's note: STORED expressions that reference an
    // FK column trip MySQL 8.4/HeatWave with a misleading FK error.
    await knex.raw(
      "ALTER TABLE bookings " +
      "ADD COLUMN active_booking_key INT UNSIGNED " +
      "GENERATED ALWAYS AS (IF(status <> 'cancelled', member_id, NULL)) VIRTUAL",
    );
  }
  const [indexRows] = await knex.raw(
    "SHOW INDEX FROM bookings WHERE Key_name = 'bookings_session_active_unique'",
  );
  if (indexRows.length === 0) {
    await knex.raw(
      "ALTER TABLE bookings ADD UNIQUE KEY bookings_session_active_unique (class_session_id, active_booking_key)",
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE bookings DROP INDEX bookings_session_active_unique').catch(() => {});
  await knex.raw('ALTER TABLE bookings DROP COLUMN active_booking_key').catch(() => {});
  await knex.raw('ALTER TABLE bookings DROP CHECK bookings_status_check').catch(() => {});
  // Data is one-way: restoring the classes table + class_id isn't attempted
  // (P2.4's data migration wasn't reversed either).
  for (const col of ['attendance_confirmed_by', 'attendance_confirmed_at', 'cancelled_at', 'waitlisted_at', 'booked_at', 'waitlist_position']) {
    if (await knex.schema.hasColumn('bookings', col)) {
      await knex.schema.alterTable('bookings', (t) => t.dropColumn(col));
    }
  }
  if (await knex.schema.hasColumn('bookings', 'class_session_id')) {
    await knex.raw('ALTER TABLE bookings DROP FOREIGN KEY bookings_class_session_id_foreign').catch(() => {});
    await knex.schema.alterTable('bookings', (t) => t.dropColumn('class_session_id'));
  }
};
