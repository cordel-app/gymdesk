/**
 * #2125 N3a — a payment request names its plan assignment by one column, `anchor_plan_snapshot_id`.
 *
 * Since N1 (migration 461) an assignment's id is its anchor plan snapshot's id, so a payment request
 * carried that id twice: in `user_membership_id` (no FK since migration 457) and in
 * `plan_assignment_id` (migration 431, FK to `plan_snapshots (id)`). Oscar's decision on #2125 keeps
 * one, named for what it points at:
 *
 *   1. drops the FK and key of `plan_assignment_id` and renames it to `anchor_plan_snapshot_id`;
 *   2. fills it from `user_membership_id` where it is NULL and that id is still an anchor of the gym
 *      (`assignment_id = id`), so a link `syncPaymentRequestAssignmentIds()` had not written yet is not
 *      lost; a `user_membership_id` naming no anchor (a discarded Draft, dev data) is left behind;
 *   3. drops `user_membership_id` and its key;
 *   4. re-adds the key and the FK, `ON DELETE SET NULL` as before: a gym delete cascades to both
 *      `payment_requests` and `plan_snapshots`, and a RESTRICT here would make that delete depend on
 *      the order InnoDB visits the two (the reason migration 431 chose SET NULL). An anchor is never
 *      deleted while its assignment exists (`deleteUnlinkedPlanSnapshots()`), so SET NULL only ever
 *      fires on a gym delete or a discarded Draft, which raises no payment request.
 *
 * `down` re-adds `user_membership_id` filled from the anchor and renames the column back.
 */

async function dropIndexIfExists(knex, table, index) {
  const [rows] = await knex.raw(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [index]);
  if (rows.length > 0) await knex.raw(`ALTER TABLE ${table} DROP INDEX ${index}`);
}

async function dropFkIfExists(knex, table, fk) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [table, fk]);
  if (rows.length > 0) await knex.raw(`ALTER TABLE ${table} DROP FOREIGN KEY ${fk}`);
}

exports.up = async (knex) => {
  if (await knex.schema.hasColumn('payment_requests', 'anchor_plan_snapshot_id')) return;

  await knex.raw('SET SESSION lock_wait_timeout = 30');
  try {
    await dropFkIfExists(knex, 'payment_requests', 'pr_plan_assignment_fk');
    await dropIndexIfExists(knex, 'payment_requests', 'pr_plan_assignment_index');
    await knex.raw('ALTER TABLE payment_requests RENAME COLUMN plan_assignment_id TO anchor_plan_snapshot_id');

    await knex.raw(
      `UPDATE payment_requests pr
         JOIN plan_snapshots a ON a.id = pr.user_membership_id AND a.gym_id = pr.gym_id AND a.assignment_id = a.id
          SET pr.anchor_plan_snapshot_id = a.id
        WHERE pr.anchor_plan_snapshot_id IS NULL AND pr.user_membership_id IS NOT NULL`);

    // Any index naming the column goes with it (MySQL drops a column from a multi-column index otherwise).
    const [idx] = await knex.raw(
      "SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_requests' AND COLUMN_NAME = 'user_membership_id'");
    for (const { name } of idx) {
      if (name !== 'PRIMARY') await knex.raw(`ALTER TABLE payment_requests DROP INDEX \`${name}\``);
    }
    await knex.raw('ALTER TABLE payment_requests DROP COLUMN user_membership_id');

    await knex.raw(
      `ALTER TABLE payment_requests
         ADD KEY pr_anchor_plan_snapshot_index (anchor_plan_snapshot_id),
         ADD CONSTRAINT pr_anchor_plan_snapshot_fk FOREIGN KEY (anchor_plan_snapshot_id)
           REFERENCES plan_snapshots (id) ON DELETE SET NULL`);
  } finally {
    await knex.raw('SET SESSION lock_wait_timeout = DEFAULT');
  }
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('payment_requests', 'anchor_plan_snapshot_id'))) return;
  await dropFkIfExists(knex, 'payment_requests', 'pr_anchor_plan_snapshot_fk');
  await dropIndexIfExists(knex, 'payment_requests', 'pr_anchor_plan_snapshot_index');
  await knex.raw('ALTER TABLE payment_requests ADD COLUMN user_membership_id INT UNSIGNED NULL AFTER gym_id');
  await knex.raw('UPDATE payment_requests SET user_membership_id = anchor_plan_snapshot_id');
  await knex.raw('ALTER TABLE payment_requests ADD KEY payment_requests_user_membership_id_index (user_membership_id)');
  await knex.raw('ALTER TABLE payment_requests RENAME COLUMN anchor_plan_snapshot_id TO plan_assignment_id');
  await knex.raw(
    `ALTER TABLE payment_requests
       ADD KEY pr_plan_assignment_index (plan_assignment_id),
       ADD CONSTRAINT pr_plan_assignment_fk FOREIGN KEY (plan_assignment_id)
         REFERENCES plan_snapshots (id) ON DELETE SET NULL`);
};
