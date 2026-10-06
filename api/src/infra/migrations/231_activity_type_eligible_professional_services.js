/**
 * #973 stage 1 — an Activity Type names the **Professional Services** that may
 * book it, not the Membership Plans.
 *
 * `activity_type_eligible_plans` (migration 139, #481) said "only members on
 * one of these Plans may book this activity". The ticket replaces that
 * relation outright:
 *
 *   > Activities should determine eligibility based on the Professional
 *   > Services that the member has access to. […] Do not introduce a direct
 *   > Activity → Membership Plan eligibility relationship as part of this
 *   > change.
 *
 * and its thread settled what "has access to" means (`Q1 wallet`): a member
 * holds *sessions* for a Professional Service through the Products they hold
 * — a purchased package, a Promotion's session grant, an Additional Service on
 * their assignment — consolidated by `domain/memberProfessionalServices.ts`
 * (#647), which already exists and already serves
 * `GET /members/:memberId/professional-services`. So the new table is the
 * Activity-side half of a relation whose Member-side half is already read.
 *
 * ## No mapping is invented (§4)
 *
 * A Membership Plan and a Professional Service are different things, and
 * nothing in the schema says which service a plan "means". The old rows are
 * therefore **not** translated: every activity starts with an empty service
 * list, and the rows that are about to go are written to the migration log
 * (one line per activity, with the plan ids) so a gym can be told what each
 * activity used to require. Under the thread's `Q3 open` an activity that
 * names no service is open to every member, so the morning after this runs
 * nobody is locked out of anything — the only behaviour that disappears is
 * the restriction itself, which has no expression left once its relation is
 * gone.
 *
 * ## Shape
 *
 * Mirrors 139: `gym_id` NOT NULL with every FK `ON DELETE CASCADE` (a deleted
 * Activity Type or Professional Service takes its rows with it), UNIQUE on the
 * pair so a replace-all `PUT` cannot double a service, and an index on
 * `(gym_id, activity_type_id)` because the booking gate reads "which services
 * does this activity name" on every non-public booking.
 *
 * ## `down`
 *
 * Recreates `activity_type_eligible_plans` **empty** with 139's columns and
 * drops the new table — the shape only, as migration 177 did for
 * `plan_allowances` and for the same reason: the rows are gone and a table
 * nobody can read is schema cruft. A build rolled back behind this migration
 * would find every non-public activity with no eligible plan and refuse every
 * booking on it, which is 139's own semantics and is why the application
 * half rolls back first.
 */

const NEW_TABLE = 'activity_type_eligible_professional_services';
const OLD_TABLE = 'activity_type_eligible_plans';

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(NEW_TABLE))) {
    await knex.schema.createTable(NEW_TABLE, (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36)').notNullable().references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('activity_type_id').unsigned().notNullable().references('id').inTable('activity_types').onDelete('CASCADE');
      t.integer('professional_service_id').unsigned().notNullable().references('id').inTable('professional_services').onDelete('CASCADE');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      t.unique(['activity_type_id', 'professional_service_id'], 'atps_activity_type_service_unique');
      t.index(['gym_id', 'activity_type_id'], 'atps_gym_activity_type_idx');
    });
  }

  if (await knex.schema.hasTable(OLD_TABLE)) {
    // §4: nothing is mapped, so say what is being dropped rather than drop it
    // silently. One line per activity, with the plans it named.
    const rows = await knex(OLD_TABLE)
      .select('gym_id', 'activity_type_id')
      .select(knex.raw('GROUP_CONCAT(membership_plan_id ORDER BY membership_plan_id) AS plan_ids'))
      .groupBy('gym_id', 'activity_type_id')
      .orderBy(['gym_id', 'activity_type_id']);
    if (rows.length > 0) {
      console.log(`[migration 231] dropping ${OLD_TABLE}: ${rows.length} activity type(s) named eligible plans (not mapped to services, see #973 §4):`);
      for (const r of rows) {
        console.log(`[migration 231]   gym ${r.gym_id} activity_type ${r.activity_type_id} -> plans [${r.plan_ids}]`);
      }
    }
    await knex.schema.dropTable(OLD_TABLE);
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable(OLD_TABLE))) {
    await knex.schema.createTable(OLD_TABLE, (t) => {
      t.increments('id').unsigned().primary();
      t.specificType('gym_id', 'char(36)').notNullable().references('id').inTable('gyms').onDelete('CASCADE');
      t.integer('activity_type_id').unsigned().notNullable().references('id').inTable('activity_types').onDelete('CASCADE');
      t.integer('membership_plan_id').unsigned().notNullable().references('id').inTable('membership_plans').onDelete('CASCADE');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      t.unique(['activity_type_id', 'membership_plan_id'], 'atep_activity_type_plan_unique');
    });
  }
  await knex.schema.dropTableIfExists(NEW_TABLE);
};
