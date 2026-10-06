/**
 * #980 stage 3 — an occurrence's own **Eligible Professional Services**.
 *
 * Stage 1 made the Trainer and the Space editable on the calendar event, stage
 * 2 the Waitlist setting, and the thread's `Q1 multi` answer made the
 * Professional Services a *multi-valued relation on the occurrence* rather
 * than the single inherited `professional_service_id` (#647) — waiting on
 * #973 stage 1 so the occurrence-level and the Activity-level relations are
 * one model. They are: `activity_type_eligible_professional_services`
 * (migration 231) says which services may book an Activity Type, and this
 * table says which may book **this occurrence**.
 *
 * ## Inherit unless overridden, like the Waitlist
 *
 * `calendar_events.eligible_services_override` is the occurrence's "I have a
 * list of my own" flag — `0` (every existing row, and every new one) means
 * the occurrence follows its Activity Type's list exactly as a NULL
 * `waitlist_mode` follows the Activity Type's setting, and `1` means the rows
 * in this table are the list, *including an empty one*, which under #973's
 * `Q3 open` means "any member may book this event" even when the activity is
 * restricted. A list cannot say "inherit" by being empty, which is why the
 * flag exists; nothing is copied at materialization and nothing propagates
 * from the Activity Type, so an occurrence that was never edited keeps
 * following an Activity whose list changes later.
 *
 * The single `calendar_events.professional_service_id` is **untouched**: it
 * is which service *delivers* the occurrence (#647's slot matching), a
 * different question from who may book it.
 *
 * ## Shape
 *
 * One raw `CREATE TABLE` with every constraint named `ceeps_*`, the way 229
 * and 231 are — the Knex builder's generated FK names would exceed MySQL's
 * 64-character identifier limit for a 45-character table name (71 and 77
 * characters for the event and service FKs) and fail the create on a fresh
 * database (231's header has the whole failure). `gym_id`
 * NOT NULL, every FK `ON DELETE CASCADE`, UNIQUE on the pair, an index on
 * `(gym_id, calendar_event_id)` for the booking gate's read.
 *
 * The flag column is added last with a default, which is INSTANT on MySQL
 * 8.0.12+; no CHECK (`ADD CONSTRAINT` rebuilds `calendar_events`, and the
 * router writes it only ever as `? 1 : 0`).
 */

const TABLE = 'calendar_event_eligible_professional_services';
const PREFIX = 'ceeps';
const FLAG = 'eligible_services_override';

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id                      INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id                  CHAR(36)     NOT NULL,
        calendar_event_id       INT UNSIGNED NOT NULL,
        professional_service_id INT UNSIGNED NOT NULL,
        created_at              DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY ${PREFIX}_event_service_unique (calendar_event_id, professional_service_id),
        KEY ${PREFIX}_gym_event_idx (gym_id, calendar_event_id),
        KEY ${PREFIX}_professional_service_idx (professional_service_id),
        CONSTRAINT ${PREFIX}_gym_fk FOREIGN KEY (gym_id)
          REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT ${PREFIX}_event_fk FOREIGN KEY (calendar_event_id)
          REFERENCES calendar_events(id) ON DELETE CASCADE,
        CONSTRAINT ${PREFIX}_professional_service_fk FOREIGN KEY (professional_service_id)
          REFERENCES professional_services(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }
  if (!(await knex.schema.hasColumn('calendar_events', FLAG))) {
    await knex.schema.alterTable('calendar_events', (t) => {
      t.boolean(FLAG).notNullable().defaultTo(false);
    });
  }
};

exports.down = async (knex) => {
  // Roll the application half back first: `SESSION_SELECT` reads the flag and
  // the table by name, so dropping either under a deployed API answers
  // ER_BAD_FIELD_ERROR / ER_NO_SUCH_TABLE — a bare 500 (#966) on every
  // calendar read.
  if (await knex.schema.hasColumn('calendar_events', FLAG)) {
    await knex.schema.alterTable('calendar_events', (t) => t.dropColumn(FLAG));
  }
  await knex.schema.dropTableIfExists(TABLE);
};
