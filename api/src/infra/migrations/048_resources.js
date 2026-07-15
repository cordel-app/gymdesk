/**
 * #59: Resource — a bookable equipment/asset catalog scoped to a Center,
 * shaped like rooms (name/description/status) plus a quantity count.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('resources')) return;
  await knex.schema.createTable('resources', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('center_id').unsigned().notNullable()
      .references('id').inTable('centers').onDelete('CASCADE');
    t.string('name', 160).notNullable();
    t.text('description');
    t.integer('quantity').unsigned().notNullable().defaultTo(1);
    t.string('status', 20).notNullable().defaultTo('active');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('modified_at');
    t.integer('modified_by_membership_id').unsigned()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.datetime('deleted_at');
  });
  await knex.raw(
    "ALTER TABLE resources ADD CONSTRAINT resources_status_check " +
    "CHECK (status IN ('active','inactive'))",
  );
  await knex.raw(
    "ALTER TABLE resources ADD COLUMN active_name_key VARCHAR(160) " +
    "GENERATED ALWAYS AS (IF(deleted_at IS NULL, name, NULL)) VIRTUAL",
  );
  await knex.raw(
    "ALTER TABLE resources ADD UNIQUE KEY resources_center_active_name_unique (center_id, active_name_key)",
  );
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE resources DROP CHECK resources_status_check').catch(() => {});
  await knex.schema.dropTableIfExists('resources');
};
