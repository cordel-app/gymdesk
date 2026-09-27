/**
 * #801: remove Activity management from the **Space** side.
 *
 * `space_activity_types` (migration 067 §5) existed for exactly one screen: the
 * `ACTIVITIES` checkbox list inside the Space form, where a staff member could
 * tick which Activity Types a Space hosts. §1–§3 of the ticket retire that
 * section, and §11 asks for this migration if the field is "exclusively
 * obsolete and no longer used elsewhere".
 *
 * It is. Before this PR the table had exactly three readers/writers, all of them
 * in `api/src/api/spaces.ts` and all of them serving that one section:
 *
 *   - `GET  /spaces/:id/activity-types` — filled the checkbox list and the
 *     expanded card's read-only chips;
 *   - `PUT  /spaces/:id/activity-types` — the DELETE-then-INSERT the Space form
 *     issued right after `PUT /spaces/:id`;
 *   - `POST /spaces/:id/duplicate` — copied the assignments onto the copy.
 *
 * Nothing else ever read it: not the calendar, not `class_sessions` (which
 * carries its own `space_id`), not booking eligibility, not billing. A grep for
 * the table name across `api/src` and both frontends hit only those three
 * routes, the test-helper cleanup and migration 067 itself.
 *
 * **The direction that survives is the Activity's own `default_space_id`**
 * (`activity_types.default_space_id`, migration 081), which is what §4 and §9
 * protect: an Activity Type names the Space it runs in by default, the Activity
 * Types page edits it, and `activity-types.ts` reads it when materialising
 * sessions. This table was the same relation configured from the other side,
 * with no consumer — so removing it takes no behaviour with it, exactly as
 * migration 177 did for `plan_allowances`' mirror of
 * `activity_type_eligible_plans`. §7 forbids a replacement relation, and there
 * is none.
 *
 * `down` recreates the table empty, with migration 067's four columns and its
 * FKs and unique key. The rows are gone for good and deliberately not archived:
 * nothing could read them, so a table kept alive for a rollback would be schema
 * cruft. Rolling the API back to a build that still serves those three routes
 * would find the table empty, which reads as "this Space has no Activities" — the
 * same answer the removed UI gave for an unconfigured Space, so the rollback is
 * degraded rather than broken.
 *
 * Forward ordering, as for migrations 176/177: run this *after* the API build
 * that stops querying the table is live, or the previous build answers
 * `ER_NO_SUCH_TABLE` on all three. Note that `.github/workflows/deploy.yml` runs
 * `knex migrate:latest` *before* it restarts the API container, so honouring this
 * means deploying the API on its own first — exactly as migrations 176, 177, 179
 * and 184 ask; `docs/go-to-production.md` carries the checklist item.
 */

exports.up = async (knex) => {
  await knex.schema.dropTableIfExists('space_activity_types');
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable('space_activity_types'))) {
    await knex.schema.createTable('space_activity_types', (t) => {
      t.increments('id').primary();
      t.integer('space_id').unsigned().notNullable()
        .references('id').inTable('spaces').onDelete('CASCADE');
      t.integer('activity_type_id').unsigned().notNullable()
        .references('id').inTable('activity_types').onDelete('CASCADE');
      t.specificType('gym_id', 'char(36)').notNullable()
        .references('id').inTable('gyms').onDelete('CASCADE');
      t.unique(['space_id', 'activity_type_id'], 'sat_space_activity_unique');
    });
  }
};
