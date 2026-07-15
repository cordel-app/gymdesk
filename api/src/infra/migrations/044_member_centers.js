/**
 * #59: MemberCenter — a Member may belong to one or more Centers; exactly
 * one is the default. PK (member_id, center_id). A generated-column unique
 * index enforces "at most one active default center per member" as
 * defense-in-depth on top of the app-level transaction in member-centers.ts.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('member_centers')) return;
  await knex.schema.createTable('member_centers', (t) => {
    t.specificType('gym_id', 'char(36)').notNullable()
      .references('id').inTable('gyms').onDelete('CASCADE');
    t.integer('member_id').unsigned().notNullable()
      .references('id').inTable('members').onDelete('CASCADE');
    t.integer('center_id').unsigned().notNullable()
      .references('id').inTable('centers').onDelete('CASCADE');
    t.boolean('is_default').notNullable().defaultTo(false);
    t.datetime('assigned_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.integer('assigned_by_membership_id').unsigned()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('modified_at');
    t.integer('modified_by_membership_id').unsigned()
      .references('id').inTable('gym_memberships').onDelete('SET NULL');
    t.datetime('deleted_at');
    t.primary(['member_id', 'center_id']);
    t.index(['gym_id', 'center_id'], 'member_centers_center_index');
  });
  await knex.raw(
    "ALTER TABLE member_centers ADD COLUMN default_key INT UNSIGNED " +
    "GENERATED ALWAYS AS (IF(is_default = 1 AND deleted_at IS NULL, member_id, NULL)) VIRTUAL",
  );
  await knex.raw(
    "ALTER TABLE member_centers ADD UNIQUE KEY member_centers_one_default_unique (default_key)",
  );
};

exports.down = async (knex) => knex.schema.dropTableIfExists('member_centers');
