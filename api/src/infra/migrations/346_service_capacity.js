/**
 * #1984 stage 1 — an independent capacity per Professional Service.
 *
 *   activity_type_eligible_professional_services.capacity
 *       The Activity Type's default for that service. NULL (every existing row)
 *       means "the event's own capacity", i.e. today's behaviour, so nothing is
 *       backfilled and a single-person service is untouched.
 *   calendar_event_service_capacity
 *       One row per occurrence override. It holds overrides only; the effective
 *       capacity is COALESCE(override, Activity Type default, event capacity)
 *       (api/src/domain/serviceCapacity.ts). It is a table of its own because the
 *       occurrence's list of eligible services (migration 232) is all-or-nothing:
 *       overriding one capacity must not detach the occurrence from the Activity
 *       Type's list.
 *
 * `down` drops the table and the column; capacities configured since are lost,
 * the bookings themselves are untouched.
 */
const TABLE = 'calendar_event_service_capacity';
const PREFIX = 'cesc';

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('activity_type_eligible_professional_services', 'capacity'))) {
    await knex.raw(
      'ALTER TABLE activity_type_eligible_professional_services ADD COLUMN capacity INT UNSIGNED NULL AFTER professional_service_id',
    );
  }
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id                      INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id                  CHAR(36)     NOT NULL,
        calendar_event_id       INT UNSIGNED NOT NULL,
        professional_service_id INT UNSIGNED NOT NULL,
        capacity                INT UNSIGNED NOT NULL,
        created_at              DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY ${PREFIX}_event_service_unique (calendar_event_id, professional_service_id),
        KEY ${PREFIX}_gym_event_idx (gym_id, calendar_event_id),
        KEY ${PREFIX}_professional_service_idx (professional_service_id),
        CONSTRAINT chk_${PREFIX}_capacity CHECK (capacity > 0),
        CONSTRAINT ${PREFIX}_gym_fk FOREIGN KEY (gym_id)
          REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT ${PREFIX}_event_fk FOREIGN KEY (calendar_event_id)
          REFERENCES calendar_events(id) ON DELETE CASCADE,
        CONSTRAINT ${PREFIX}_professional_service_fk FOREIGN KEY (professional_service_id)
          REFERENCES professional_services(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
  if (await knex.schema.hasColumn('activity_type_eligible_professional_services', 'capacity')) {
    await knex.raw('ALTER TABLE activity_type_eligible_professional_services DROP COLUMN capacity');
  }
};
