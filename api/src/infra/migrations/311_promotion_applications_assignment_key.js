/**
 * #1995 stage 1 — an applied Promotion is the assignment's again.
 *
 * Migration 262 dropped `user_membership_promotions.user_membership_id` and keyed
 * the application only by `product_set_id`. The owner reversed that (#1995,
 * option 2): a Membership Plan Promotion application and its grant snapshots
 * belong to the `user_memberships` assignment, and a same-plan successor will
 * own a copy of them (stage 2). This stage only re-adds the key and backfills it;
 * every reader keeps working off `product_set_id`, so nothing changes behaviour.
 *
 * The grant snapshot tables (`user_membership_promotion_*_snapshot`) hang off the
 * application's id, so they follow the application and need no column of their
 * own. The column is nullable (a Product-target application has no assignment)
 * and the FK is SET NULL. Backfill: the assignment the application's version
 * projects (`product_sets.user_membership_id`), else the latest version of its
 * chain that does. Each step is guarded on its own (ALTER TABLE is not
 * transactional). One-way: `down()` is a no-op.
 */

const TABLE = 'user_membership_promotions';
const FK = 'user_membership_promotions_user_membership_id_foreign';
const INDEX = 'ump_user_membership_index';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(TABLE, 'user_membership_id'))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN user_membership_id INT UNSIGNED NULL`);
  }
  const [idx] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [TABLE, INDEX]);
  if (Number(idx[0].cnt) === 0) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD INDEX ${INDEX} (user_membership_id)`);
  }

  await knex.raw(
    `UPDATE ${TABLE} ump
       JOIN product_sets ps ON ps.id = ump.product_set_id
        SET ump.user_membership_id = COALESCE(
              ps.user_membership_id,
              (SELECT p2.user_membership_id FROM product_sets p2
                WHERE p2.root_product_set_id = ps.root_product_set_id
                  AND p2.user_membership_id IS NOT NULL
                ORDER BY p2.version DESC, p2.id DESC LIMIT 1))
      WHERE ump.user_membership_id IS NULL`);

  const [fk] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'`, [TABLE, FK]);
  if (Number(fk[0].cnt) === 0) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD CONSTRAINT ${FK}
         FOREIGN KEY (user_membership_id) REFERENCES user_memberships (id) ON DELETE SET NULL`);
  }
};

exports.down = async function down() {
  // One-way: the key is re-derivable from the version.
};
