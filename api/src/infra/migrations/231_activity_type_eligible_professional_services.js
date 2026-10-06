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
 * The columns mirror 139 — `gym_id` NOT NULL with every FK `ON DELETE
 * CASCADE` (a deleted Activity Type or Professional Service takes its rows
 * with it), UNIQUE on the pair so a replace-all `PUT` and Duplicate's copy
 * cannot double a service, and an index on `(gym_id, activity_type_id)`
 * because the booking gate reads "which services does this activity name" on
 * every non-public booking — but the *statement* mirrors 229, not 139: one raw
 * `CREATE TABLE` with every constraint named `ateps_*` (the alias both readers
 * use). The Knex builder would emit CREATE plus five separate ALTERs and name
 * the FKs `<table>_<column>_foreign`, and with a 44-character table name two
 * of those exceed MySQL's 64-character identifier limit (ER_TOO_LONG_IDENT):
 * the third statement fails, the table is left with its PK and the `gym_id`
 * FK only, and a re-run finds `hasTable()` true and skips the rest for good —
 * no cascade, no UNIQUE, no index, and nothing at runtime to notice. One
 * statement is atomic, so the one `hasTable()` guard is exact.
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
const PREFIX = 'ateps';

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(NEW_TABLE))) {
    await knex.raw(`
      CREATE TABLE ${NEW_TABLE} (
        id                      INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id                  CHAR(36)     NOT NULL,
        activity_type_id        INT UNSIGNED NOT NULL,
        professional_service_id INT UNSIGNED NOT NULL,
        created_at              DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY ${PREFIX}_activity_type_service_unique (activity_type_id, professional_service_id),
        KEY ${PREFIX}_gym_activity_type_idx (gym_id, activity_type_id),
        KEY ${PREFIX}_professional_service_idx (professional_service_id),
        CONSTRAINT ${PREFIX}_gym_fk FOREIGN KEY (gym_id)
          REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT ${PREFIX}_activity_type_fk FOREIGN KEY (activity_type_id)
          REFERENCES activity_types(id) ON DELETE CASCADE,
        CONSTRAINT ${PREFIX}_professional_service_fk FOREIGN KEY (professional_service_id)
          REFERENCES professional_services(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (await knex.schema.hasTable(OLD_TABLE)) {
    // §4: nothing is mapped, so say what is being dropped rather than drop it
    // silently. One line per activity, with the plans it named. The default
    // `group_concat_max_len` (1024) would silently truncate a long list, and
    // this log is the only thing the migration leaves behind.
    await knex.raw('SET SESSION group_concat_max_len = 1048576');
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

    // The other half of §4: a non-public activity naming NO plan was blocked
    // for everyone under #481 and is open to everyone under `Q3 open` — the
    // one row this change lets *in* rather than out, and the one the query
    // above cannot see because there is no row to group.
    const [closed] = await knex.raw(
      `SELECT at.gym_id, at.id AS activity_type_id
       FROM activity_types at
       LEFT JOIN ${OLD_TABLE} atep ON atep.activity_type_id = at.id
       WHERE at.public_event = 0 AND at.deleted_at IS NULL AND atep.id IS NULL
       ORDER BY at.gym_id, at.id`,
    );
    if (closed.length > 0) {
      console.log(`[migration 231] ${closed.length} non-public activity type(s) named no eligible plan (blocked for everyone under #481; open to everyone from now on):`);
      for (const r of closed) {
        console.log(`[migration 231]   gym ${r.gym_id} activity_type ${r.activity_type_id}`);
      }
    }

    await knex.schema.dropTable(OLD_TABLE);
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable(OLD_TABLE))) {
    // One statement for the same reason as `up`, keeping 139's generated names
    // so a rolled-back schema is the one 139 produced.
    await knex.raw(`
      CREATE TABLE ${OLD_TABLE} (
        id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id             CHAR(36)     NOT NULL,
        activity_type_id   INT UNSIGNED NOT NULL,
        membership_plan_id INT UNSIGNED NOT NULL,
        created_at         DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY atep_activity_type_plan_unique (activity_type_id, membership_plan_id),
        CONSTRAINT activity_type_eligible_plans_gym_id_foreign FOREIGN KEY (gym_id)
          REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT activity_type_eligible_plans_activity_type_id_foreign FOREIGN KEY (activity_type_id)
          REFERENCES activity_types(id) ON DELETE CASCADE,
        CONSTRAINT activity_type_eligible_plans_membership_plan_id_foreign FOREIGN KEY (membership_plan_id)
          REFERENCES membership_plans(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }
  await knex.schema.dropTableIfExists(NEW_TABLE);
};
