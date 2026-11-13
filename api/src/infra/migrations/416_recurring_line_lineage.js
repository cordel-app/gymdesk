/**
 * #2126 stage 6a: a recurring line snapshot records the snapshot it was copied from, and "inherited" is
 * derived (the Product-side counterpart of #2125 M5a, migration 387).
 *
 * Since stage 5c-2c-2 a new version links its predecessor's recurring lines, and a copy is written only by
 * `copyLine()` (`recurring-line-writer.ts`): the merge of an active version into a Draft and a writer owning a
 * shared line (`ownRecurringLine()`). Until now the copy said it was inherited through
 * `product_periodical_snapshots.is_inherited = 1`, a second record of one fact (the copy exists because it was
 * taken from another snapshot). What replaces it is lineage: `copied_from_periodical_snapshot_id`, written by
 * `copyLine()` and nothing else, which `recurringLineInheritedSql()` reads.
 *
 * The flag is dropped from the four Product snapshot tables:
 *   - `product_periodical_snapshots`: replaced by the lineage above;
 *   - `product_oneoff_snapshots`, `product_session_snapshots`: a one-time purchase is never copied, every
 *     writer has written 0 and nothing reads it;
 *   - `product_promotion_snapshots`: the sync has written a constant 0 and nothing reads it (a Plan
 *     Promotion application's own `user_membership_promotions.is_inherited` is a different column and is
 *     untouched).
 *
 * Self FK ON DELETE SET NULL: a source snapshot is deleted with a discarded Draft or a removed Draft line,
 * and a lineage pointing at a deleted row must not block that delete.
 *
 * Existing rows: a periodical copy carrying is_inherited = 1 gets its lineage from the closest earlier
 * snapshot of the same gym with the same `line_ref` (a copy keeps the line's `line_ref`, so that snapshot is
 * the one it was taken from, or one of its ancestors); a copy with no such match (a line with no `line_ref`)
 * keeps NULL (dev data, as M5a). The rollback is lossy: it restores the flag only on periodical rows with a
 * lineage.
 */

const FLAG_TABLES = [
  'product_periodical_snapshots',
  'product_oneoff_snapshots',
  'product_session_snapshots',
  'product_promotion_snapshots',
];

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('product_periodical_snapshots', 'copied_from_periodical_snapshot_id'))) {
    await knex.raw(`
      ALTER TABLE product_periodical_snapshots
        ADD COLUMN copied_from_periodical_snapshot_id INT UNSIGNED NULL,
        ADD KEY ppsnap_copied_from_index (copied_from_periodical_snapshot_id),
        ADD CONSTRAINT ppsnap_copied_from_fk FOREIGN KEY (copied_from_periodical_snapshot_id)
          REFERENCES product_periodical_snapshots (id) ON DELETE SET NULL`);
  }
  if (await knex.schema.hasColumn('product_periodical_snapshots', 'is_inherited')) {
    await knex.raw(`
      UPDATE product_periodical_snapshots c
        JOIN (SELECT c2.id AS copy_id, MAX(src.id) AS src_id
                FROM product_periodical_snapshots c2
                JOIN product_periodical_snapshots src ON src.gym_id = c2.gym_id
                                                     AND src.line_ref = c2.line_ref
                                                     AND src.id < c2.id
               WHERE c2.is_inherited = 1 AND c2.copied_from_periodical_snapshot_id IS NULL
               GROUP BY c2.id) m ON m.copy_id = c.id
         SET c.copied_from_periodical_snapshot_id = m.src_id`);
  }
  for (const table of FLAG_TABLES) {
    if (await knex.schema.hasColumn(table, 'is_inherited')) {
      await knex.raw(`ALTER TABLE ${table} DROP COLUMN is_inherited`);
    }
  }
};

exports.down = async (knex) => {
  for (const table of FLAG_TABLES) {
    if (!(await knex.schema.hasColumn(table, 'is_inherited'))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN is_inherited TINYINT(1) NOT NULL DEFAULT 0`);
    }
  }
  if (await knex.schema.hasColumn('product_periodical_snapshots', 'copied_from_periodical_snapshot_id')) {
    await knex.raw(`UPDATE product_periodical_snapshots SET is_inherited = 1
                     WHERE copied_from_periodical_snapshot_id IS NOT NULL`);
    await knex.raw(`
      ALTER TABLE product_periodical_snapshots
        DROP FOREIGN KEY ppsnap_copied_from_fk,
        DROP KEY ppsnap_copied_from_index,
        DROP COLUMN copied_from_periodical_snapshot_id`);
  }
};
