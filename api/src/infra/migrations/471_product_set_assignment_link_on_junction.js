/**
 * #2125 N3b — the link from a Product Set to the assignment it projects moves off `product_sets` onto
 * the plan-snapshot junction (Oscar's architecture decision on #2125: `product_sets.plan_assignment_id`
 * is removed; option A of the N3b question, the default taken while it is unanswered).
 *
 *   product_set_plan_snapshots.projects_assignment   1 on the set's rows whose plan snapshot names the
 *                                                    assignment the set projects, else 0. A set with no
 *                                                    flagged row is linked to no assignment (a plain
 *                                                    Draft linking the running plan's snapshot unchanged,
 *                                                    a Pending Payment or cancelled set, a superseded set
 *                                                    the bridge unlinked), which a column derived from
 *                                                    the snapshots alone could not say.
 *
 * Written only by `linkProductSetToAssignment()` (`api/plan-assignment-sync.ts`); read through
 * `productSetAssignmentSql()` (`domain/planAssignments.ts`). No CHECK: a 0/1 flag the one writer sets.
 *
 *   1. adds the flag (NOT NULL DEFAULT 0, so every existing row starts unlinked);
 *   2. flags (and once more right before step 4), for every set with a `plan_assignment_id`, its rows whose snapshot names that anchor;
 *   3. refuses, listing them, while a set with a `plan_assignment_id` has no such row: dropping the
 *      column would silently turn it into an unlinked set (`npm run plan-assignments:validate` on the
 *      previous release lists the same sets as drift);
 *   4. drops `product_sets.plan_assignment_id` with its key and FK (migration 432's).
 *
 * Steps 2-3 run only while the column exists, so a re-run after step 4 is a no-op. `down` recreates the
 * column and fills it from the flags (the lowest flagged anchor of each set), then drops the flag.
 */

async function flagLinkedRows(knex) {
  await knex.raw(`
    UPDATE product_set_plan_snapshots j
      JOIN product_sets ps ON ps.id = j.product_set_id
      JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
       SET j.projects_assignment = IF(s.anchor_plan_snapshot_id <=> ps.plan_assignment_id, 1, 0)
     WHERE ps.plan_assignment_id IS NOT NULL OR j.projects_assignment = 1`);

  const ORPHANS = `FROM product_sets ps
     WHERE ps.plan_assignment_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots j
                        WHERE j.product_set_id = ps.id AND j.projects_assignment = 1)`;
  const [[{ total }]] = await knex.raw(`SELECT COUNT(*) AS total ${ORPHANS}`);
  if (Number(total) > 0) {
    const [orphans] = await knex.raw(`SELECT ps.id, ps.gym_id, ps.status, ps.plan_assignment_id ${ORPHANS} ORDER BY ps.id LIMIT 20`);
    throw new Error(
      `migration 471: ${total} Product Set(s) linked to an assignment none of whose plan snapshots they link: `
      + orphans.map((r) => `${r.id} (gym ${r.gym_id}, ${r.status}, assignment ${r.plan_assignment_id})`).join(', ')
      + '. Correct or discard them first (development data is disposable).');
  }
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('product_set_plan_snapshots', 'projects_assignment'))) {
    await knex.raw(`ALTER TABLE product_set_plan_snapshots
                      ADD COLUMN projects_assignment TINYINT(1) NOT NULL DEFAULT 0`);
  }
  if (!(await knex.schema.hasColumn('product_sets', 'plan_assignment_id'))) return;

  await flagLinkedRows(knex);

  await knex.raw('SET SESSION lock_wait_timeout = 30');
  try {
    // Again right before the DDL: a link the previous API wrote since the first pass is flagged too.
    await flagLinkedRows(knex);
    await knex.raw(`
      ALTER TABLE product_sets
        DROP FOREIGN KEY product_sets_plan_assignment_fk,
        DROP KEY product_sets_plan_assignment_index,
        DROP COLUMN plan_assignment_id`);
  } finally {
    await knex.raw('SET SESSION lock_wait_timeout = DEFAULT');
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('product_sets', 'plan_assignment_id'))) {
    await knex.raw(`
      ALTER TABLE product_sets
        ADD COLUMN plan_assignment_id INT UNSIGNED NULL,
        ADD KEY product_sets_plan_assignment_index (plan_assignment_id),
        ADD CONSTRAINT product_sets_plan_assignment_fk FOREIGN KEY (plan_assignment_id)
          REFERENCES plan_snapshots (id) ON DELETE SET NULL`);
  }
  if (await knex.schema.hasColumn('product_set_plan_snapshots', 'projects_assignment')) {
    await knex.raw(`
      UPDATE product_sets ps
         SET ps.plan_assignment_id = (
           SELECT MIN(s.anchor_plan_snapshot_id) FROM product_set_plan_snapshots j
             JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
            WHERE j.product_set_id = ps.id AND j.projects_assignment = 1)`);
    await knex.raw('ALTER TABLE product_set_plan_snapshots DROP COLUMN projects_assignment');
  }
};
