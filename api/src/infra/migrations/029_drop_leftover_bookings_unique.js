/**
 * P2.5 aftershock: migration 001 created `UNIQUE(member_id, class_id)` on
 * bookings. Migration 014 dropped `class_id` but Knex left the index alive
 * with just `member_id` (index columns were only dropped for the removed FK).
 * The result was a "one active booking per member EVER" constraint that
 * ER_DUP_ENTRY'd every second booking a member tried, session-agnostic.
 * P2.5's waitlist-aware index (bookings_session_active_unique) is the one we
 * actually want; drop the leftover.
 *
 * Caught by the P2.1–P6.3 E2E script when Alice couldn't book a second
 * session after the first was cancelled.
 */
exports.up = async (knex) => {
  const [rows] = await knex.raw(
    "SHOW INDEX FROM bookings WHERE Key_name = 'bookings_member_class_unique'",
  );
  if (rows.length === 0) return;
  // The bookings.member_id FK relies on this index; can't drop it directly.
  // Drop the FK, drop the leftover unique, add a plain non-unique index, then re-add the FK
  // (which will now use the plain index).
  await knex.raw('ALTER TABLE bookings DROP FOREIGN KEY bookings_member_id_foreign');
  await knex.raw('ALTER TABLE bookings DROP INDEX bookings_member_class_unique');
  await knex.raw('ALTER TABLE bookings ADD INDEX bookings_member_id_index (member_id)');
  await knex.raw('ALTER TABLE bookings ADD CONSTRAINT bookings_member_id_foreign FOREIGN KEY (member_id) REFERENCES members(id)');
};

exports.down = async (knex) => {
  // Best-effort restore for parity; the constraint was buggy so recreating it
  // would break booking. Skipped intentionally.
};
