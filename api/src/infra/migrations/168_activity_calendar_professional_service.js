/**
 * #647 stage 1: the Professional Service link the Personal Training slot
 * booking feature is built on.
 *
 * The ticket's central eligibility rule — "the Professional Service
 * associated with the `calendar_event` matches a Professional Service
 * available to the Member" — had nothing to read on the event side:
 * `calendar_events` (migration 082) only carries `activity_type_id`, and
 * `professional_services` (#484, migration 140) was until now linked to gyms
 * and to Sellable Items (migration 153), never to the calendar.
 *
 * Per the answers on the issue thread, the attribute is added in *both*
 * places: on the Activity Type, which is where an occurrence inherits it
 * from, and on the calendar event itself, so a manually created event can
 * set it directly and an occurrence can be corrected later without touching
 * the Activity Type.
 *
 * Both columns are nullable with `ON DELETE SET NULL`: a Professional
 * Service is a catalog row that may be retired, and losing it must never
 * cascade away an Activity Type or a scheduled event (the same choice
 * migration 082 makes for `activity_type_id`/`space_id`/`trainer_membership_id`).
 *
 * No backfill: both columns start NULL everywhere, and no existing rule maps
 * an Activity Type onto one of the five system Professional Services, so any
 * automatic assignment would be invented data. Staff set the attribute, and
 * from then on `api/src/api/activity-types.ts` propagates a change to
 * not-yet-started occurrences like it already does for space/trainer/centre.
 *
 * Index choice: `(gym_id, professional_service_id, starts_at)` on
 * `calendar_events` is exactly the lookup stage 2's availability projection
 * runs — every occurrence of one Professional Service inside a date window,
 * for one gym — and its leftmost prefix also serves the plain
 * "events of this service in this gym" count. Because the FK is on
 * `professional_service_id` alone and that is *not* the leftmost column,
 * MySQL additionally creates its own single-column index named after the
 * constraint. That index is never referenced here: it appears implicitly on
 * `ADD CONSTRAINT` and disappears implicitly with the column in `down()`.
 *
 * Names are given explicitly for the indexes rather than left to Knex —
 * `calendar_events_gym_id_professional_service_id_starts_at_index` is 62
 * characters, two short of MySQL's 64-character identifier limit — and for
 * the foreign keys to match, following the convention of migrations 153/156.
 *
 * Cost: only `ADD COLUMN` is ALGORITHM=INSTANT here. `ADD CONSTRAINT …
 * FOREIGN KEY` is not INPLACE while `foreign_key_checks` is on (the
 * default), so MySQL falls back to ALGORITHM=COPY and rebuilds the table,
 * blocking concurrent DML for the duration — on `calendar_events` that is by
 * far the most expensive statement in this file. Harmless on the dev/CI
 * datasets; see `docs/go-to-production.md` for the deploy note.
 *
 * Each statement is guarded independently via `information_schema` rather
 * than under one `hasColumn()` check: MySQL commits DDL implicitly, so
 * Knex's migration transaction protects nothing here. Were all three
 * statements behind the column guard and the FK or the index failed, the
 * committed column would make a re-run skip the whole block and record the
 * migration as applied with no foreign key and no index — silently and
 * permanently. Migrations 134/140/155/156/164 guard per statement for the
 * same reason.
 */

const COLUMN = 'professional_service_id';

const TARGETS = [
  {
    table: 'activity_types',
    fk: 'activity_types_ps_id_fk',
    index: 'activity_types_gym_ps_index',
    indexColumns: '(gym_id, professional_service_id)',
  },
  {
    table: 'calendar_events',
    fk: 'calendar_events_ps_id_fk',
    index: 'calendar_events_gym_ps_range_idx',
    indexColumns: '(gym_id, professional_service_id, starts_at)',
  },
];

async function foreignKeyExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [table, name],
  );
  return row.cnt > 0;
}

async function indexExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

exports.up = async (knex) => {
  for (const { table, fk, index, indexColumns } of TARGETS) {
    if (!(await knex.schema.hasColumn(table, COLUMN))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN ${COLUMN} INT UNSIGNED NULL`);
    }
    if (!(await foreignKeyExists(knex, table, fk))) {
      await knex.raw(
        `ALTER TABLE ${table} ADD CONSTRAINT ${fk} FOREIGN KEY (${COLUMN}) ` +
        'REFERENCES professional_services (id) ON DELETE SET NULL',
      );
    }
    if (!(await indexExists(knex, table, index))) {
      await knex.raw(`ALTER TABLE ${table} ADD INDEX ${index} ${indexColumns}`);
    }
  }
};

// Dropped in the reverse order: the composite index cannot go while the
// foreign key might still be relying on it (errno 1553), and the column
// cannot go while either exists. Each drop is guarded for the same
// implicit-commit reason as `up()` — a failure partway through must leave a
// retry able to finish rather than dying on "constraint does not exist".
exports.down = async (knex) => {
  for (const { table, fk, index } of [...TARGETS].reverse()) {
    if (await foreignKeyExists(knex, table, fk)) {
      await knex.raw(`ALTER TABLE ${table} DROP FOREIGN KEY ${fk}`);
    }
    if (await indexExists(knex, table, index)) {
      await knex.raw(`ALTER TABLE ${table} DROP INDEX ${index}`);
    }
    if (await knex.schema.hasColumn(table, COLUMN)) {
      await knex.raw(`ALTER TABLE ${table} DROP COLUMN ${COLUMN}`);
    }
  }
};
