/**
 * #59: backward-compatible data migration. For every existing Gym, ensure
 * exactly one active Center exists (named after the gym), assign every
 * existing Member to it as their default, and backfill center_id on
 * rooms/class_sessions/bookings from that same default center.
 *
 * Idempotent / re-runnable: each step only touches rows that don't already
 * have what it's about to set.
 */
exports.up = async (knex) => {
  // 1. Every gym without an active Center gets one, named after the gym.
  const [gyms] = await knex.raw('SELECT id, name FROM gyms');
  for (const gym of gyms) {
    const [existing] = await knex.raw(
      'SELECT id FROM centers WHERE gym_id = ? AND deleted_at IS NULL LIMIT 1',
      [gym.id],
    );
    if (existing.length > 0) continue;
    await knex.raw(
      "INSERT INTO centers (gym_id, name, status, created_at) VALUES (?, ?, 'active', UTC_TIMESTAMP())",
      [gym.id, gym.name],
    );
  }

  // 2. Every non-deleted member with no active center row gets their gym's
  //    (now-guaranteed) default center, as their default.
  await knex.raw(`
    INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at)
    SELECT m.gym_id, m.id,
           (SELECT MIN(c.id) FROM centers c WHERE c.gym_id = m.gym_id AND c.deleted_at IS NULL),
           1, UTC_TIMESTAMP()
    FROM members m
    LEFT JOIN member_centers mc ON mc.member_id = m.id AND mc.deleted_at IS NULL
    WHERE m.deleted_at IS NULL AND mc.member_id IS NULL
    ON DUPLICATE KEY UPDATE is_default = 1, deleted_at = NULL
  `);

  // 3. Backfill center_id on rooms / class_sessions / bookings from each
  //    row's gym default center.
  for (const table of ['rooms', 'class_sessions', 'bookings']) {
    await knex.raw(`
      UPDATE ${table} t
      JOIN (SELECT gym_id, MIN(id) AS default_center_id FROM centers WHERE deleted_at IS NULL GROUP BY gym_id) d
        ON d.gym_id = t.gym_id
      SET t.center_id = d.default_center_id
      WHERE t.center_id IS NULL
    `);
  }
};

// One-directional data migration — same precedent as 013/014 (class_sessions
// backfill from legacy `classes`); down() is a no-op.
exports.down = async () => {};
