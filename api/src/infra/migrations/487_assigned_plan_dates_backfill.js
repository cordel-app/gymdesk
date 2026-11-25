/**
 * #3403: every Assigned Nutrition Plan and Assigned Training Plan has a start
 * date, and every one that has ended has an end date.
 *
 * The writers already stamp both (creation sets `start_date`, Complete and a
 * superseding plan set `end_date`, an expired Training Plan requires one); this
 * fills the rows written before they did:
 *
 * - a Nutrition Plan with no `start_date` takes the day it was created;
 * - a completed Nutrition Plan, and a completed or expired Training Plan, with no
 *   `end_date` takes the day it was last modified (never before its start).
 *   Migration 306 declined this backfill because `modified_at` also moves on
 *   unrelated edits; but a completed plan is read-only (both routers refuse to
 *   edit it), so its last modification is the one that ended it. This is the
 *   closest record of that day there is, and the owner's #3403 asks for no
 *   ended plan without an end date.
 *
 * Active and Draft plans keep a NULL end date: they have not ended, and the UI
 * reads that as Open-ended. Deleted rows are left alone. Data-only, idempotent.
 */

exports.up = async (knex) => {
  await knex.raw(
    `UPDATE member_nutrition_plans
        SET start_date = DATE(created_at)
      WHERE start_date IS NULL AND status <> 'deleted'`,
  );
  await knex.raw(
    `UPDATE member_nutrition_plans
        SET end_date = GREATEST(COALESCE(start_date, DATE(created_at)), DATE(COALESCE(modified_at, created_at)))
      WHERE status = 'completed' AND end_date IS NULL`,
  );
  await knex.raw(
    `UPDATE training_plans
        SET end_date = GREATEST(start_date, DATE(COALESCE(modified_at, created_at)))
      WHERE status IN ('completed', 'expired') AND end_date IS NULL`,
  );
};

// A backfill cannot tell its own values from ones written since; nothing to undo.
exports.down = async () => {};
