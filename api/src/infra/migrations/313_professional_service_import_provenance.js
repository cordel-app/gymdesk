/**
 * #2004 — Import Base Professional Services: the provenance of a gym's service.
 *
 * `professional_services.base_professional_service_id` names the Base
 * Professional Service (`gym_id IS NULL`) a gym-owned service was imported from.
 * It is the one record of "already imported", and
 * `UNIQUE (gym_id, base_professional_service_id)` makes a repeated or concurrent
 * import a no-op at the database (NULLs, i.e. every service the gym created
 * itself, never collide). Deleting the Base service sets it to NULL: the copy is
 * the gym's own and stays. `max_capacity` already exists (migration 296).
 * No backfill: nothing is inferred about services that predate the column.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('professional_services', 'base_professional_service_id')) return;
  await knex.raw(`
    ALTER TABLE professional_services
      ADD COLUMN base_professional_service_id INT UNSIGNED NULL,
      ADD UNIQUE KEY ps_gym_base_service_unique (gym_id, base_professional_service_id),
      ADD CONSTRAINT ps_base_service_fk
        FOREIGN KEY (base_professional_service_id) REFERENCES professional_services (id) ON DELETE SET NULL
  `);
};

exports.down = async () => {};
