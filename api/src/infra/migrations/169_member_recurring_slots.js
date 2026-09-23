/**
 * #647 stage 3: the Member's recurring Personal Training slot selections.
 *
 * Stage 2 projects which recurring slots a Member *could* take
 * (`domain/personalTrainingSlots.ts`); this table records which ones they
 * actually picked. Per the issue thread's answer to Q3 — "just track in the
 * membership the slots per week. For example Monday 10:00 - 11:00 and
 * Wednesday 12:00 - 13:00 […] that should be enough to forecast what will
 * happen the following weeks" — a selection is a *weekly pattern*, not a list
 * of dates: one row per (member, weekday, time, activity type, professional
 * service, center), and the concrete `calendar_events` occurrences are
 * resolved from it at Book time (stage 3) and again every night (stage 4).
 *
 * Why the identity is six columns and not a link to one occurrence: the whole
 * point of the rolling window is that next month's occurrences do not exist
 * yet. `start_time`/`end_time` are gym-local TIME values, matching the way
 * stage 2 groups occurrences — a slot is "Monday 10:00–11:00 local", which is
 * a different UTC instant either side of a DST change.
 *
 * **The weekday column is `iso_weekday`, not `weekday`, on purpose.** Every
 * other weekday column in this schema — `gym_operating_hours` (134),
 * `activity_type_schedule_rules` (108/115), `trainer_availability`,
 * `training_plans` — is 0=Sunday … 6=Saturday. This feature is built on
 * luxon's ISO numbering (1=Monday … 7=Sunday), which is also what the stage-2
 * API already returns and what the Mon–Sun grid orders its columns by, so
 * converting on the way in would leave the stored value disagreeing with the
 * endpoint that writes it. Naming the column for its base is what stops the
 * silent off-by-one when stage 4's nightly job joins gym closures: ISO Sunday
 * is 7 here and 0 there.
 *
 * `center_id` belongs in the identity for the same reason it is in stage 2's
 * slot key: in a multi-center gym the same activity runs at the same local
 * time in two places, and those are two slots a Member picks between.
 *
 * Uniqueness through a generated column, not a plain UNIQUE KEY: `center_id`
 * is nullable, and MySQL lets any number of rows repeat a NULL inside a unique
 * index — so a single-center gym (where `center_id` is always NULL) would get
 * no duplicate protection at all from `UNIQUE (member_id, iso_weekday, …,
 * center_id)`. `selection_key` folds NULL to 0 and makes the pattern unique
 * for real, which is what keeps a double-submitted PUT from storing the same
 * slot twice (the router treats the resulting duplicate-key error as the
 * concurrent write having already stored the row). VIRTUAL rather than STORED:
 * MySQL rejects a STORED generated column over foreign-key columns (see
 * migrations 007, 132 and 164 for the same workaround).
 *
 * Deleting a row is how a Member deselects a slot. That deliberately does
 * *not* touch bookings: §5 says existing bookings "must follow the existing
 * cancellation/booking rules and must not be silently modified by this
 * feature", so deselecting only stops *future* occurrences from being booked
 * — already-created ones stay until staff cancel them through the booking
 * path. Nothing here references `calendar_event_bookings`.
 *
 * ON DELETE CASCADE on every FK except `created_by_membership_id`. For
 * `gyms`/`members`/`centers` that is the live rule. For `activity_types` and
 * `professional_services` it is belt-and-braces: both are soft-delete catalogs
 * the application never hard-deletes (migration 164 skips the CASCADE on
 * `gym_charges` for exactly that reason, and 168 chose SET NULL so an
 * occurrence outlives a retired service). The difference here is that a
 * selection *is* the tuple — without its activity type or professional service
 * it identifies nothing and could never be booked again — so if the row ever
 * did go, taking the selection with it is the only correct answer.
 *
 * Every statement is guarded independently via `information_schema`, and the
 * table is created bare rather than with knex's inline `.references()`:
 * knex renders those as separate `ALTER TABLE … ADD CONSTRAINT` statements,
 * MySQL commits DDL implicitly, and Knex's migration transaction protects
 * nothing here. Behind a single `hasTable()` check, a CREATE that commits
 * followed by a failing ADD CONSTRAINT would make a re-run skip the block and
 * record the migration as applied with foreign keys missing — silently and
 * permanently (migration 168's header calls out the same failure mode).
 *
 * Cost: a CREATE TABLE on an empty table plus a handful of ALTERs on it —
 * instant at any data size, so unlike migration 168 there is no deploy note
 * for this one.
 */

const TABLE = 'member_recurring_slots';

const FOREIGN_KEYS = [
  ['fk_mrs_gym', 'gym_id', 'gyms (id)', 'CASCADE'],
  ['fk_mrs_member', 'member_id', 'members (id)', 'CASCADE'],
  ['fk_mrs_activity_type', 'activity_type_id', 'activity_types (id)', 'CASCADE'],
  ['fk_mrs_professional_service', 'professional_service_id', 'professional_services (id)', 'CASCADE'],
  ['fk_mrs_center', 'center_id', 'centers (id)', 'CASCADE'],
  ['fk_mrs_created_by', 'created_by_membership_id', 'gym_memberships (id)', 'SET NULL'],
];

const CHECKS = {
  chk_mrs_iso_weekday: 'iso_weekday BETWEEN 1 AND 7',
  chk_mrs_times: 'end_time > start_time',
};

async function constraintExists(knex, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [TABLE, name],
  );
  return row.cnt > 0;
}

async function indexExists(knex, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [TABLE, name],
  );
  return row.cnt > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, (t) => {
      t.increments('id').unsigned().primary();

      t.specificType('gym_id', 'char(36)').notNullable();
      t.integer('member_id').unsigned().notNullable();

      /** luxon's ISO weekday, 1=Monday … 7=Sunday — see the header. */
      t.specificType('iso_weekday', 'tinyint unsigned').notNullable();
      /** Gym-local start/end of the recurring slot. */
      t.time('start_time').notNullable();
      t.time('end_time').notNullable();

      t.integer('activity_type_id').unsigned().notNullable();
      t.integer('professional_service_id').unsigned().notNullable();
      /** NULL in a single-center gym, as on `calendar_events`. */
      t.integer('center_id').unsigned().nullable();

      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      t.integer('created_by_membership_id').unsigned().nullable();
    });
  }

  // Both reads run "this gym's selections for this member"; stage 4's nightly
  // job walks the same index a gym at a time. The leftmost prefix also backs
  // the gym_id foreign key, so it is created before the constraints.
  if (!(await indexExists(knex, 'mrs_gym_member_index'))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD INDEX mrs_gym_member_index (gym_id, member_id)`);
  }

  for (const [name, column, target, action] of FOREIGN_KEYS) {
    if (!(await constraintExists(knex, name))) {
      await knex.raw(
        `ALTER TABLE ${TABLE} ADD CONSTRAINT ${name} FOREIGN KEY (${column}) ` +
        `REFERENCES ${target} ON DELETE ${action}`,
      );
    }
  }

  if (!(await knex.schema.hasColumn(TABLE, 'selection_key'))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD COLUMN selection_key VARCHAR(96) ` +
      "GENERATED ALWAYS AS (CONCAT_WS(':', member_id, iso_weekday, start_time, end_time, " +
      'activity_type_id, professional_service_id, COALESCE(center_id, 0))) VIRTUAL',
    );
  }
  if (!(await constraintExists(knex, 'mrs_selection_unique'))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD UNIQUE KEY mrs_selection_unique (selection_key)`);
  }

  for (const [name, expression] of Object.entries(CHECKS)) {
    if (!(await constraintExists(knex, name))) {
      await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${name} CHECK (${expression})`);
    }
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
};
