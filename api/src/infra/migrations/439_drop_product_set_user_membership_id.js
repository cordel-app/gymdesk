/**
 * #2125 M6b-46: the last step of the M6b plan's re-key for Product Sets (§3: "`product_sets.user_membership_id`
 * → dropped; a set's assignments are its linked snapshots' `assignment_id`s").
 *
 * Since M6b-37 … M6b-45 every reader asks the set's `plan_assignment_id` (migration 432) — the anchor
 * (lowest plan snapshot id) naming the legacy assignment — and since M6b-44 every writer names that
 * snapshot when it links a set, so the anchor exists at link time. `user_membership_id` was only still
 * written beside it; this migration drops it with its key and FK, and the writers link a set through
 * `plan_assignment_id` alone (`PRODUCT_SET_ASSIGNMENT_ANCHOR_SQL`, `api/plan-assignment-sync.ts`).
 *
 * Guard: the migration refuses to run — dropping nothing — while any Product Set's `user_membership_id`
 * disagrees with the legacy assignment its anchor names (`plan_snapshots.source_user_membership_id` of
 * the snapshot at `plan_assignment_id`), because the column would then be the only record of a link the
 * readers no longer see. Inspect with `npm run plan-assignments:validate` (on the previous release, whose
 * `product_set_assignment_mismatch` check compares the two) and repair before deploying. Nothing is
 * repaired here: which side is right is a judgment, not a rule.
 *
 * `down` re-adds the column, key and FK and backfills it from the anchor.
 */

async function disagreeingSets(knex) {
  const [rows] = await knex.raw(`
    SELECT ps.id, ps.gym_id, ps.user_membership_id, ps.plan_assignment_id,
           anc.source_user_membership_id AS anchor_user_membership_id
      FROM product_sets ps
      LEFT JOIN plan_snapshots anc ON anc.id = ps.plan_assignment_id
     WHERE NOT (ps.user_membership_id <=> anc.source_user_membership_id)
     ORDER BY ps.id
     LIMIT 20`);
  return rows;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('product_sets', 'user_membership_id'))) return;
  const bad = await disagreeingSets(knex);
  if (bad.length > 0) {
    const sample = bad.map((r) =>
      `set ${r.id} (gym ${r.gym_id}): user_membership_id=${r.user_membership_id}, anchor names ${r.anchor_user_membership_id}`).join('; ');
    throw new Error(
      `migration 439: ${bad.length}${bad.length === 20 ? '+' : ''} Product Set(s) whose user_membership_id disagrees `
      + `with their plan_assignment_id anchor; repair before dropping the column (${sample})`);
  }
  await knex.raw(`
    ALTER TABLE product_sets
      DROP FOREIGN KEY product_sets_user_membership_fk,
      DROP KEY product_sets_user_membership_index,
      DROP COLUMN user_membership_id`);
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('product_sets', 'user_membership_id')) return;
  await knex.raw(`
    ALTER TABLE product_sets
      ADD COLUMN user_membership_id INT UNSIGNED NULL,
      ADD KEY product_sets_user_membership_index (user_membership_id),
      ADD CONSTRAINT product_sets_user_membership_fk FOREIGN KEY (user_membership_id)
        REFERENCES user_memberships (id) ON DELETE SET NULL`);
  await knex.raw(`
    UPDATE product_sets ps
      JOIN plan_snapshots anc ON anc.id = ps.plan_assignment_id
      JOIN user_memberships um ON um.id = anc.source_user_membership_id
       SET ps.user_membership_id = anc.source_user_membership_id`);
};
