/**
 * #832: Add `mandatory` to gym_charges (Sellable Items).
 *
 * A product-level flag on a Sellable Item, edited as a single checkbox on both
 * kinds of row the Sellable Items page holds: the per-gym System items seeded
 * from `charge_types` (`is_system = 1` — the ticket's "Base Sellable Items",
 * among them the Insurance Fee) and the gym's own (`is_system = 0`, "Custom").
 * Both live in this one table, so one column serves both and there is nothing
 * to keep consistent between two implementations.
 *
 * This ticket adds and persists the flag only: nothing reads it. Automatic
 * inclusion in Billing Plans, preventing removal from one, Membership Plan
 * Benefits and any Insurance Fee special case are explicitly out of scope and
 * land in a later ticket that consumes the attribute.
 *
 * NOT NULL DEFAULT 0 does the backfill in one statement — MySQL stamps every
 * existing row with `0`, which is the value the ticket asks existing items to
 * receive ("Existing Sellable Items must therefore remain non-mandatory").
 * `t.boolean` is a tinyint(1), the same shape
 * `promotions.only_applicable_for_new_members` (migration 163) took;
 * `is_system` on this table is a bare `tinyint` (migration 102), which differs
 * only in the display width MySQL 8 ignores. The column is appended rather
 * than positioned with `.after()`, as migration 122 appended
 * `enrollment_status`.
 *
 * No CHECK, matching every other boolean in this schema (`gym_charges.is_system`,
 * `promotions.stackable`, `only_applicable_for_new_members` carry none): the two
 * form-driven writers validate the body and normalise to `? 1 : 0`, Duplicate
 * copies an already-constrained value, and MySQL 8 rebuilds a table under
 * ALGORITHM=COPY to add one — the same trade migrations 174/189/192 made for
 * `user_memberships`. The add itself is INSTANT.
 *
 * Deploy ordering is the natural one here, unlike the column *drops* in
 * migrations 197/199: the new API build selects `gc.mandatory`, so the schema
 * has to move first — which is what `.github/workflows/deploy.yml` already
 * does (`knex migrate:latest` runs before the API container restarts, in the
 * same job). The old build against the new schema is fine too: it never names
 * the column and the default fills it. So no API-first split and no
 * go-to-production checklist item.
 *
 * The column add is guarded with hasColumn so a retry after a partial failure
 * resumes cleanly, per the convention in 122_gym_charges_enrollment_status.js /
 * 163_promotion_only_new_members.js.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('gym_charges', 'mandatory'))) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.boolean('mandatory').notNullable().defaultTo(0);
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('gym_charges', 'mandatory')) {
    await knex.schema.alterTable('gym_charges', (t) => {
      t.dropColumn('mandatory');
    });
  }
};
