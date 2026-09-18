// #546: Link Session-type Sellable Items to Professional Services.
//
// A Sellable Item with type='sessions' (the "Session" package type — e.g. the
// #371 "Personal Training Class Package (10 Sessions)" system item) can now
// be delivered by one or more Professional Services (#484). A session
// package may bundle sessions delivered by different services (e.g. a mixed
// PT + Physiotherapy package), so this is many-to-many, following the same
// join-table shape already used for `gym_professional_services` (#484) and
// `nutrition_library_item_categories` (#501).
//
// `sellable_item_professional_services` carries its own `gym_id` (hard
// constraint: every domain table has one, every query filters by it) even
// though it is technically derivable from `sellable_item_id` — this lets
// every query on the join table filter by gym_id directly rather than always
// joining back through gym_charges, and matches the existing join-table
// convention in this codebase.
exports.up = async (knex) => {
  if (await knex.schema.hasTable('sellable_item_professional_services')) return;

  await knex.schema.createTable('sellable_item_professional_services', (t) => {
    t.increments('id').primary();
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('sellable_item_id').unsigned().notNullable()
      .references('id').inTable('gym_charges').onDelete('CASCADE');
    t.integer('professional_service_id').unsigned().notNullable()
      .references('id').inTable('professional_services').onDelete('CASCADE');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
    t.integer('created_by_membership_id').unsigned().nullable()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');

    t.unique(['sellable_item_id', 'professional_service_id'], 'sips_item_service_unique');
    t.index(['gym_id'], 'sips_gym_id_index');
    t.index(['professional_service_id'], 'sips_service_id_index');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('sellable_item_professional_services');
};
