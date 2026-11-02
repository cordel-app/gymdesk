/**
 * #2125 stage 21 — coverage is each Membership Plan snapshot's own.
 *
 * `product_set_members` held the chain's coverage and `syncPlanSnapshot()` copied it onto the
 * version's primary snapshot. Oscar (#2125, 2026-11-02): coverage is managed per plan, with
 * `plan_snapshot_beneficiaries` as the one source and no Product Set-to-member table.
 *
 *  1. every snapshot of a chain starts with the chain's current coverage (the agreed starting
 *     point, nothing guessed): rows are only added, never removed;
 *  2. `user_membership_members` is re-created as a read-only view over the beneficiaries of the
 *     latest snapshot of each assignment (same four columns, same readers);
 *  3. `product_set_members` is dropped.
 *
 * Repeatable: each step is guarded. One-way: `down()` throws.
 */
const isTable = async (knex, name) => {
  const [rows] = await knex.raw(
    'SELECT TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]);
  return rows[0] ? rows[0].t : null;
};

exports.up = async function up(knex) {
  if ((await isTable(knex, 'product_set_members')) === 'BASE TABLE') {
    await knex.raw(
      `INSERT IGNORE INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner)
       SELECT s.gym_id, s.id, psm.member_id, 0
         FROM plan_snapshots s
         JOIN product_sets ps ON ps.id = s.product_set_id AND ps.gym_id = s.gym_id
         JOIN product_set_members psm ON psm.root_product_set_id = ps.root_product_set_id AND psm.gym_id = ps.gym_id
        WHERE psm.member_id <> s.member_id`);
  }

  await knex.raw(
    `CREATE OR REPLACE VIEW user_membership_members AS
     SELECT DISTINCT COALESCE(s.source_user_membership_id, ps.user_membership_id) AS user_membership_id,
            b.gym_id AS gym_id, b.member_id AS member_id, b.is_owner AS is_owner, b.created_at AS created_at
       FROM plan_snapshots s
       JOIN product_sets ps ON ps.id = s.product_set_id AND ps.gym_id = s.gym_id
       JOIN plan_snapshot_beneficiaries b ON b.plan_snapshot_id = s.id AND b.gym_id = s.gym_id
      WHERE COALESCE(s.source_user_membership_id, ps.user_membership_id) IS NOT NULL
        AND s.id = (SELECT MAX(s2.id) FROM plan_snapshots s2
                      JOIN product_sets ps2 ON ps2.id = s2.product_set_id
                     WHERE s2.gym_id = s.gym_id
                       AND COALESCE(s2.source_user_membership_id, ps2.user_membership_id)
                         = COALESCE(s.source_user_membership_id, ps.user_membership_id))`);

  if ((await isTable(knex, 'product_set_members')) === 'BASE TABLE') {
    await knex.raw('DROP TABLE product_set_members');
  }
};

exports.down = async function down() {
  throw new Error('358 is one-way: coverage is the plan snapshots\' own');
};
