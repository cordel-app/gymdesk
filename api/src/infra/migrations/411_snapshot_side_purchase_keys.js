/**
 * #2126 stage 5d-1 — the Product snapshot tables stop depending on the legacy Product tables.
 *
 * Stage 5d retires `member_products_oneoff_snapshot`, `member_products_oneoff_promotion_snapshot` and
 * `member_products_recurrent_snapshot`. Before any of them can be dropped, nothing outside the three may
 * point at them and the one rule only the purchase record enforced must hold on the snapshots too:
 *
 * 1. `user_membership_promotions.recurrent_snapshot_id` (a line-owned Product Promotion, migration 330)
 *    keeps its value — the line's id, which is the snapshot's `source_id` — and its FK now references
 *    `product_periodical_snapshots (source_id)` (UNIQUE since migration 348) instead of the legacy line,
 *    still ON DELETE CASCADE: the line writer deletes the snapshot with the line, so an application still
 *    goes with its line.
 * 2. `product_oneoff_snapshots.member_product_id` and `product_session_snapshots.member_product_id` lose
 *    their FK to the purchase record (migration 348). The column stays as the purchase's id.
 * 3. The pending-purchase key (#1121 stage 2, migration 228's `mprod_pending_purchase_key`: one
 *    `pending_payment` purchase per member and Product) is added to the two purchase snapshot tables, for
 *    purchase rows only (`member_product_id IS NOT NULL`). The legacy key stays until the record is dropped,
 *    so the two agree by construction (the purchase writer writes both from the same values).
 *
 * Refuses to run, changing nothing, while an application names a line with no snapshot or two pending
 * snapshots of one purchase key exist; the error names them. No row is
 * rewritten. `down` restores migration 330's and 348's FKs and drops the keys.
 */

const PURCHASE_TABLES = [
  { table: 'product_oneoff_snapshots', abbr: 'proneoff' },
  { table: 'product_session_snapshots', abbr: 'prsess' },
];

const KEY_SQL = "IF(status = 'pending_payment' AND member_product_id IS NOT NULL, CONCAT(member_id, ':', product_id), NULL)";

async function fkExists(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [table, name]);
  return rows.length > 0;
}

exports.up = async (knex) => {
  const [orphans] = await knex.raw(
    `SELECT ump.id FROM user_membership_promotions ump
      WHERE ump.recurrent_snapshot_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM product_periodical_snapshots s WHERE s.source_id = ump.recurrent_snapshot_id)`);
  if (orphans.length > 0) {
    throw new Error(`migration 411: ${orphans.length} Promotion application(s) name a recurring line with no snapshot `
     
      + `(ids ${orphans.slice(0, 20).map((r) => r.id).join(', ')})`);
  }
  for (const { table } of PURCHASE_TABLES) {
    const [dups] = await knex.raw(
      `SELECT ${KEY_SQL} AS k, COUNT(*) AS n FROM ${table}
        WHERE status = 'pending_payment' AND member_product_id IS NOT NULL AND product_id IS NOT NULL
        GROUP BY k HAVING n > 1`);
    if (dups.length > 0) {
      throw new Error(`migration 411: ${table} holds ${dups.length} duplicated pending purchase key(s): ${dups.slice(0, 20).map((r) => r.k).join(', ')}`);
    }
  }

  if (await fkExists(knex, 'user_membership_promotions', 'ump_recurrent_snapshot_fk')) {
    await knex.raw('ALTER TABLE user_membership_promotions DROP FOREIGN KEY ump_recurrent_snapshot_fk');
  }
  await knex.raw(
    `ALTER TABLE user_membership_promotions ADD CONSTRAINT ump_recurrent_snapshot_fk
       FOREIGN KEY (recurrent_snapshot_id) REFERENCES product_periodical_snapshots (source_id) ON DELETE CASCADE`);

  for (const { table, abbr } of PURCHASE_TABLES) {
    if (await fkExists(knex, table, `${abbr}_purchase_fk`)) {
      await knex.raw(`ALTER TABLE ${table} DROP FOREIGN KEY ${abbr}_purchase_fk`);
    }
    if (!(await knex.schema.hasColumn(table, 'pending_purchase_key'))) {
      await knex.raw(
        `ALTER TABLE ${table}
           ADD COLUMN pending_purchase_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
             GENERATED ALWAYS AS (${KEY_SQL}) VIRTUAL,
           ADD UNIQUE KEY ${abbr}_pending_purchase_key (pending_purchase_key)`);
    }
  }
};

exports.down = async (knex) => {
  for (const { table, abbr } of PURCHASE_TABLES) {
    if (await knex.schema.hasColumn(table, 'pending_purchase_key')) {
      await knex.raw(`ALTER TABLE ${table} DROP INDEX ${abbr}_pending_purchase_key, DROP COLUMN pending_purchase_key`);
    }
    if (!(await fkExists(knex, table, `${abbr}_purchase_fk`))) {
      // A purchase record deleted while the FK was gone left its id behind; clear it as SET NULL would have.
      await knex.raw(
        `UPDATE ${table} t SET member_product_id = NULL
          WHERE member_product_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM member_products_oneoff_snapshot mp WHERE mp.id = t.member_product_id)`);
      await knex.raw(
        `ALTER TABLE ${table} ADD CONSTRAINT ${abbr}_purchase_fk
           FOREIGN KEY (member_product_id) REFERENCES member_products_oneoff_snapshot (id) ON DELETE SET NULL`);
    }
  }
  if (await fkExists(knex, 'user_membership_promotions', 'ump_recurrent_snapshot_fk')) {
    await knex.raw('ALTER TABLE user_membership_promotions DROP FOREIGN KEY ump_recurrent_snapshot_fk');
  }
  await knex.raw(
    `ALTER TABLE user_membership_promotions ADD CONSTRAINT ump_recurrent_snapshot_fk
       FOREIGN KEY (recurrent_snapshot_id) REFERENCES member_products_recurrent_snapshot (id) ON DELETE CASCADE`);
};
