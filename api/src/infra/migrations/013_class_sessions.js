/**
 * P2.4 (#16): create class_sessions and migrate the flat `classes` table.
 *
 * Data migration (per gym):
 *   1. For each distinct name in classes, create a class_types row with:
 *        - duration_minutes = median(ends_at - starts_at) rounded to nearest minute
 *          (median avoids outliers; a nasty typo shouldn't warp the whole type)
 *        - max_capacity     = MAX(capacity) across the group (permissive baseline;
 *          individual sessions still capture their own via max_capacity_override)
 *        - description      = MAX(description) (arbitrary — one non-null wins;
 *          survey copy shouldn't block a data migration)
 *   2. For each legacy class row, insert a class_sessions row pointing at the
 *      generated type, keeping starts_at/ends_at, and stamping
 *      max_capacity_override = capacity so effective capacity is preserved
 *      even if we later edit the type.
 *
 * The old classes table stays around until P2.5 rewires bookings.
 *
 * Reversibility: down() just drops class_sessions. It does NOT undo the
 * class_types rows this migration inserted, because a fresh install may have
 * added its own class_types on top; distinguishing "seeded here" from
 * "created by the admin" needs a marker we don't have.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('class_sessions'))) {
    await knex.schema.createTable('class_sessions', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('class_type_id').unsigned().notNullable()
        .references('id').inTable('class_types').onDelete('RESTRICT');
      t.integer('trainer_membership_id').unsigned()
        .references('id').inTable('gym_memberships').onDelete('SET NULL');
      t.integer('room_id').unsigned()
        .references('id').inTable('rooms').onDelete('SET NULL');
      t.datetime('starts_at').notNullable();
      t.datetime('ends_at').notNullable();
      t.integer('max_capacity_override').unsigned();
      t.string('status', 20).notNullable().defaultTo('scheduled');
      t.text('cancellation_reason');
      t.string('created_by', 64);
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
      t.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
      t.index(['gym_id', 'starts_at'], 'class_sessions_gym_starts_index');
    });
    await knex.raw(
      "ALTER TABLE class_sessions ADD CONSTRAINT class_sessions_status_check " +
      "CHECK (status IN ('scheduled','cancelled','completed'))",
    );
  }

  // Backfill only if the legacy `classes` table still exists and there are no
  // sessions yet (rerunning this migration on a fresh install is a no-op).
  if (!(await knex.schema.hasTable('classes'))) return;
  const [countRows] = await knex.raw('SELECT COUNT(*) AS n FROM class_sessions');
  if (countRows[0].n > 0) return;

  const [gyms] = await knex.raw('SELECT DISTINCT gym_id FROM classes');
  for (const { gym_id: gymId } of gyms) {
    const [classes] = await knex.raw(
      'SELECT id, name, description, capacity, starts_at, ends_at FROM classes WHERE gym_id = ?',
      [gymId],
    );

    // Group legacy classes by name → derive a class_type per group.
    const groups = new Map();
    for (const c of classes) {
      const g = groups.get(c.name) ?? { rows: [], descriptions: [] };
      g.rows.push(c);
      if (c.description) g.descriptions.push(c.description);
      groups.set(c.name, g);
    }

    // Type-name -> class_types.id (may already exist if the admin created it manually
    // to prepare for the migration — INSERT IGNORE handles that; then we look it up).
    for (const [name, g] of groups.entries()) {
      const durations = g.rows
        .map((r) => Math.round((new Date(r.ends_at).getTime() - new Date(r.starts_at).getTime()) / 60000))
        .filter((d) => d > 0)
        .sort((a, b) => a - b);
      const median = durations.length > 0
        ? durations[Math.floor(durations.length / 2)]
        : 60;
      const maxCap = Math.max(...g.rows.map((r) => r.capacity ?? 10));

      await knex.raw(
        `INSERT IGNORE INTO class_types
           (gym_id, name, description, duration_minutes, max_capacity, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
        [gymId, name, g.descriptions[0] ?? null, median, maxCap],
      );
      const [typeRows] = await knex.raw(
        'SELECT id FROM class_types WHERE gym_id = ? AND name = ?',
        [gymId, name],
      );
      const typeId = typeRows[0].id;

      for (const c of g.rows) {
        await knex.raw(
          `INSERT INTO class_sessions
             (gym_id, class_type_id, starts_at, ends_at, max_capacity_override, status)
           VALUES (?, ?, ?, ?, ?, 'scheduled')`,
          [gymId, typeId, c.starts_at, c.ends_at, c.capacity],
        );
      }
    }
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE class_sessions DROP CHECK class_sessions_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('class_sessions');
};
