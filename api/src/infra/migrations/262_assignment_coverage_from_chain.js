/**
 * #1325 PR 3e-4b — an assignment no longer carries rows of its own.
 *
 * Coverage (who an assignment covers) is the chain's `product_set_members`;
 * the benefit, Promotion and service rows are the version's own since 3e-4a.
 * This migration finishes the move:
 *
 *  1. backfills `product_set_members` from `user_membership_members` for every
 *     assignment's latest linked version (the chain's coverage was only ever
 *     written for versions created through a ProductSet path), so no covered
 *     member is lost;
 *  2. drops `user_membership_members` and re-creates the name as a **read-only
 *     view** over `product_sets` ⋈ `product_set_members`, same four columns, so
 *     every reader of "who does this assignment cover" asks the chain without
 *     a second spelling;
 *  3. removes the assignment-keyed copies that are left (rows with no version —
 *     none survive migration 258/261) and drops `user_membership_id`, with its
 *     keys and FK, from the five child tables.
 *
 * One-way: `down()` is a no-op, the version's own rows are the data.
 */

const CHILD_TABLES = [
  { table: 'user_membership_session', fk: 'user_membership_session_user_membership_id_foreign',
    indexes: ['user_membership_session_membership_product_unique'], generated: [] },
  { table: 'user_membership_oneoff', fk: 'user_membership_oneoff_user_membership_id_foreign',
    indexes: ['user_membership_oneoff_membership_product_unique'], generated: [] },
  { table: 'user_membership_periodical', fk: 'user_membership_periodical_user_membership_id_foreign',
    indexes: ['user_membership_periodical_membership_product_unique'], generated: [] },
  { table: 'user_membership_promotions', fk: 'user_membership_promotions_user_membership_id_foreign',
    indexes: ['ump_one_standing_per_promotion', 'ump_membership_promotion_index'],
    generated: ['standing_promotion_key'] },
  { table: 'member_products_recurrent_snapshot', fk: 'user_membership_services_user_membership_id_foreign',
    // `ums_gym_membership_index` (gym_id, user_membership_id) backs the gym FK and
    // shrinks to (gym_id) with the column; `ums_membership_index` goes with it.
    indexes: ['ums_one_open_per_item'],
    generated: ['open_service_key'] },
];

async function isTable(knex, name) {
  const [rows] = await knex.raw(
    `SELECT table_type AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`, [name]);
  return rows[0] ? String(rows[0].t) : null;
}
async function hasColumn(knex, table, column) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]);
  return rows.length > 0;
}
async function hasIndex(knex, table, index) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index]);
  return rows.length > 0;
}
async function hasFk(knex, table, fk) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ? AND constraint_type = 'FOREIGN KEY'`,
    [table, fk]);
  return rows.length > 0;
}

exports.up = async function up(knex) {
  // 1. Coverage into the chain, from the assignment-keyed table while it exists.
  if ((await isTable(knex, 'user_membership_members')) === 'BASE TABLE') {
    await knex.raw(
      `INSERT IGNORE INTO product_set_members (gym_id, root_product_set_id, member_id, is_owner)
       SELECT umm.gym_id, ps.root_product_set_id, umm.member_id, umm.is_owner
         FROM user_membership_members umm
         JOIN product_sets ps ON ps.user_membership_id = umm.user_membership_id AND ps.gym_id = umm.gym_id
        WHERE ps.root_product_set_id IS NOT NULL`);
    // The owner is always covered, whatever the table said.
    await knex.raw(
      `INSERT IGNORE INTO product_set_members (gym_id, root_product_set_id, member_id, is_owner)
       SELECT ps.gym_id, ps.root_product_set_id, ps.owner_member_id, 1
         FROM product_sets ps WHERE ps.root_product_set_id IS NOT NULL AND ps.user_membership_id IS NOT NULL`);
    await knex.raw('DROP TABLE user_membership_members');
  }

  // 2. The same name, now a read of the chain.
  await knex.raw(
    `CREATE OR REPLACE VIEW user_membership_members AS
     SELECT DISTINCT ps.user_membership_id AS user_membership_id, psm.gym_id AS gym_id,
            psm.member_id AS member_id, psm.is_owner AS is_owner, psm.created_at AS created_at
       FROM product_sets ps
       JOIN product_set_members psm
         ON psm.root_product_set_id = ps.root_product_set_id AND psm.gym_id = ps.gym_id
      WHERE ps.user_membership_id IS NOT NULL`);

  // 3. The child tables keep only the version's rows.
  for (const t of CHILD_TABLES) {
    if (!(await hasColumn(knex, t.table, 'user_membership_id'))) continue;
    await knex.raw(`DELETE FROM ${t.table} WHERE product_set_id IS NULL`);
    if (await hasFk(knex, t.table, t.fk)) await knex.raw(`ALTER TABLE ${t.table} DROP FOREIGN KEY ${t.fk}`);
    for (const idx of t.indexes) {
      if (await hasIndex(knex, t.table, idx)) await knex.raw(`ALTER TABLE ${t.table} DROP INDEX ${idx}`);
    }
    for (const col of t.generated) {
      if (await hasColumn(knex, t.table, col)) await knex.raw(`ALTER TABLE ${t.table} DROP COLUMN ${col}`);
    }
    await knex.raw(`ALTER TABLE ${t.table} DROP COLUMN user_membership_id`);
  }
};

exports.down = async function down() {
  // One-way: the chain's coverage and the version's rows are the data.
};
