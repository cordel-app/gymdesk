/**
 * #635 stage 10: retire **`membership_plan_benefits`**, P1.4's plan-keyed
 * benefit vocabulary.
 *
 * §1/§2 asked for the legacy Membership Plan benefit concepts to be removed and
 * replaced by the Promotion structure; stage 1 added that structure
 * (`membership_plan_session`/`_oneoff`/`_periodical`, migration 173), stage 4
 * dropped `plan_charge_benefits` (176) and `plan_allowances` (177). This table
 * is the last one left: a Membership Plan benefit keyed to a row of the global
 * `benefit_types` vocabulary (migration 006), with its own quantity, recurrence
 * and validity window.
 *
 * §18 asks what reads it before it is deleted:
 *
 *   - **Nothing writes it.** There is no endpoint, no admin UI and no seed that
 *     has ever inserted a row since migration 006 created the table — the Plans
 *     page never grew an editor for it.
 *   - **One reader**, `GET /me/membership`, which listed it as the Member app's
 *     `BENEFITS` section. Stage 10 re-points that section at the assignment's
 *     own snapshot (`user_membership_{oneoff,session,periodical}`), which is
 *     what the Member is actually billed for and what §13/§14 require a Member
 *     to keep seeing after the Plan is edited.
 *   - **Billing: nothing, ever.** A row here carried no price, and since stage 3
 *     (#714) every surface that prices an assignment reads its own snapshot.
 *
 * `benefit_types` itself is deliberately kept: it is a global vocabulary with
 * its own read-only router (`GET /benefit-types`), so retiring it is a separate
 * decision from retiring the Plan-side table that referenced it.
 *
 * `down` recreates the table empty, with migration 006's columns, foreign keys,
 * index and CHECK. The rows are gone for good and deliberately not archived —
 * nothing bills off them and nothing has written one in the project's lifetime.
 * As for migrations 176 and 177, run this *after* the API build that stops
 * reading the table is live, or the previous build 500s on `ER_NO_SUCH_TABLE`
 * (see `docs/go-to-production.md`).
 */

exports.up = async (knex) => {
  // The repo has no writer, but a row inserted by hand on a deployed database
  // would vanish silently and DDL is not transactional — so say what is being
  // destroyed rather than abort an unattended deploy (migration 179 logs the
  // same way).
  if (await knex.schema.hasTable('membership_plan_benefits')) {
    const [rows] = await knex.raw('SELECT COUNT(*) AS cnt FROM membership_plan_benefits');
    const count = Number(rows[0].cnt);
    if (count > 0) {
      console.warn(`[184] dropping membership_plan_benefits with ${count} row(s) — not archived (#635 stage 10)`);
    }
  }
  await knex.schema.dropTableIfExists('membership_plan_benefits');
};

// CREATE TABLE, each ADD CONSTRAINT and the index are separate
// non-transactional statements, so one hasTable() guard around all of them
// would let a crash in between leave a re-run skipping the rest for good — each
// is guarded on its own, the way migration 177 does it. The names below are
// knex's own auto-generated ones, so the restored shape keeps migration 006's
// naming exactly (006's `down()` drops the CHECK by that name).
const hasConstraint = async (knex, table, name) => {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return Number(rows[0].cnt) > 0;
};

// An index is not a constraint — it lives in STATISTICS, not TABLE_CONSTRAINTS.
const hasIndex = async (knex, table, name) => {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, name],
  );
  return Number(rows[0].cnt) > 0;
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable('membership_plan_benefits'))) {
    await knex.schema.createTable('membership_plan_benefits', (t) => {
      t.increments('id').primary();
      t.specificType('gym_id', 'char(36)').notNullable();
      t.integer('membership_plan_id').unsigned().notNullable();
      t.integer('benefit_type_id').unsigned().notNullable();
      t.integer('quantity');
      t.integer('duration_days');
      t.string('recurrence', 20);
      t.date('valid_from');
      t.date('valid_to');
      // CURRENT_TIMESTAMP, not the UTC_TIMESTAMP() the house rule asks for:
      // a restore path reproduces migration 006's shape verbatim.
      t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    });
  }

  const constraints = [
    ['membership_plan_benefits_gym_id_foreign',
     'ADD CONSTRAINT `membership_plan_benefits_gym_id_foreign` FOREIGN KEY (`gym_id`) REFERENCES `gyms` (`id`) ON DELETE CASCADE'],
    ['membership_plan_benefits_membership_plan_id_foreign',
     'ADD CONSTRAINT `membership_plan_benefits_membership_plan_id_foreign` FOREIGN KEY (`membership_plan_id`) REFERENCES `membership_plans` (`id`) ON DELETE CASCADE'],
    // No cascade on this one — migration 006 left the vocabulary FK RESTRICT.
    ['membership_plan_benefits_benefit_type_id_foreign',
     'ADD CONSTRAINT `membership_plan_benefits_benefit_type_id_foreign` FOREIGN KEY (`benefit_type_id`) REFERENCES `benefit_types` (`id`)'],
    ['membership_plan_benefits_recurrence_check',
     'ADD CONSTRAINT membership_plan_benefits_recurrence_check '
     + "CHECK (recurrence IS NULL OR recurrence IN ('monthly','yearly'))"],
  ];
  for (const [name, sql] of constraints) {
    if (!(await hasConstraint(knex, 'membership_plan_benefits', name))) {
      await knex.raw(`ALTER TABLE membership_plan_benefits ${sql}`);
    }
  }

  if (!(await hasIndex(knex, 'membership_plan_benefits', 'mpb_plan_index'))) {
    await knex.raw('ALTER TABLE membership_plan_benefits ADD INDEX `mpb_plan_index` (`membership_plan_id`)');
  }
};
