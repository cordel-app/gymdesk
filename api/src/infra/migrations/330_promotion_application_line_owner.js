/**
 * #1991 stage 3: a Product-target Promotion application is owned by the
 * Product snapshot (the recurring line) it applies to. `recurrent_snapshot_id`
 * is set on those applications only; a Membership Plan application keeps
 * `user_membership_id`. Removing a Draft line cascades to its applications and
 * their grant snapshots.
 *
 * Backfill: an existing Product-target application is linked to the one line of
 * its version that carries a Product it grants. An application with no such
 * line, or several, stays NULL and keeps reading at the version level.
 */
const TABLE = 'user_membership_promotions';
const COLUMN = 'recurrent_snapshot_id';
const FK = 'ump_recurrent_snapshot_fk';
const INDEX = 'ump_recurrent_snapshot_idx';

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INT UNSIGNED NULL`);
  }
  const [idx] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [TABLE, INDEX]);
  if (Number(idx[0].cnt) === 0) await knex.raw(`ALTER TABLE ${TABLE} ADD INDEX ${INDEX} (${COLUMN})`);

  await knex.raw(
    `UPDATE ${TABLE} ump
       JOIN promotions p ON p.id = ump.promotion_id AND p.applies_to = 'product'
        SET ump.${COLUMN} = (
              SELECT MIN(s.id) FROM member_products_recurrent_snapshot s
               WHERE s.product_set_id = ump.product_set_id
                 AND s.product_id IN (SELECT g.product_id FROM user_membership_promotion_periodical_snapshot g
                                       WHERE g.user_membership_promotion_id = ump.id AND g.product_id IS NOT NULL))
      WHERE ump.${COLUMN} IS NULL AND ump.user_membership_id IS NULL
        AND (SELECT COUNT(*) FROM member_products_recurrent_snapshot s
              WHERE s.product_set_id = ump.product_set_id
                AND s.product_id IN (SELECT g.product_id FROM user_membership_promotion_periodical_snapshot g
                                      WHERE g.user_membership_promotion_id = ump.id AND g.product_id IS NOT NULL)) = 1`);

  const [fk] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [TABLE, FK]);
  if (Number(fk[0].cnt) === 0) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD CONSTRAINT ${FK}
         FOREIGN KEY (${COLUMN}) REFERENCES member_products_recurrent_snapshot (id) ON DELETE CASCADE`);
  }
};

exports.down = async () => {
  // One-way: the owner is re-derivable from the version's lines.
};
