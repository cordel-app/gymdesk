/**
 * #481: Eligible Membership Plans + public_event on activity_types.
 *
 * activity_types.public_event: when true, ANY member may book the activity
 * regardless of their Membership Plan (existing entitlement/credit checks in
 * plan-allowances/package-credits still apply independently). When false,
 * only members whose active Membership Plan appears in
 * activity_type_eligible_plans may book.
 *
 * This is the INVERSE of membership_plan_centers' semantics: there, an empty
 * join table means "unrestricted" and rows narrow the allowed set. Here, the
 * join table only matters when public_event = false — an activity type with
 * public_event = true is fully unrestricted even if the join table is empty,
 * and one with public_event = false and no rows in the join table blocks
 * everyone.
 *
 * public_event defaults to true (both the column default here and the
 * create-activity-type API default) deliberately, for backward compatibility:
 * virtually every existing test and every activity type created before this
 * feature shipped has no eligible-plans configuration. Defaulting to
 * "restricted" would silently start rejecting bookings for every activity
 * type that never opted into this feature. Staff must explicitly uncheck
 * "Public Event" and pick plans to turn the restriction on.
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('activity_types', 'public_event'))) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.boolean('public_event').notNullable().defaultTo(true);
    });
  }

  if (!(await knex.schema.hasTable('activity_type_eligible_plans'))) {
    await knex.schema.createTable('activity_type_eligible_plans', (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36)').notNullable().references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('activity_type_id').unsigned().notNullable().references('id').inTable('activity_types').onDelete('CASCADE');
      t.integer('membership_plan_id').unsigned().notNullable().references('id').inTable('membership_plans').onDelete('CASCADE');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      t.unique(['activity_type_id', 'membership_plan_id'], 'atep_activity_type_plan_unique');
    });
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('activity_type_eligible_plans');
  if (await knex.schema.hasColumn('activity_types', 'public_event')) {
    await knex.schema.alterTable('activity_types', (t) => {
      t.dropColumn('public_event');
    });
  }
};
