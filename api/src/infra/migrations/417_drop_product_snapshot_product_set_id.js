/**
 * #2126 stage 6b: a Product snapshot no longer names a Product Set; the junction is the only link (the
 * Product-side counterpart of #2125 M5b, migration 388).
 *
 * Since stage 5c-2a every reader of a set's recurring lines asks `product_set_periodical_snapshots`, and since
 * stage 5c-2c-2 one line snapshot may be linked by several Product Sets (an unchanged line a Draft reuses from
 * the active set). `product_periodical_snapshots.product_set_id` was by then a second, partial record of that
 * link: it named the set that wrote the line, not necessarily a set that still links it. The same column on
 * `product_oneoff_snapshots` / `product_session_snapshots` named the Draft a cart purchase was added to
 * (#2746), which `product_set_{oneoff,session}_snapshots` already records. All three carried an
 * ON DELETE CASCADE from `product_sets`; a set's own Product snapshots are now deleted by reference, by
 * `deleteProductSetAndOwnPlanSnapshots()`, as its plan snapshots have been since M5b.
 *
 * Existing rows: every snapshot is linked since migration 374 and the writers link what they write; a
 * snapshot no set links whose column names a set (a fixture or a path that wrote the column alone) is linked
 * to that set before the column goes, which is what the junction sync would have done, so nothing becomes
 * unreachable. Nothing else moves. `prperiod_line_index (product_set_id, line_ref)` is replaced by
 * `(gym_id, line_ref)`, the shape the lineage backfill and the line readers match on.
 *
 * The rollback restores each column from the snapshot's first link (lossy for a line linked by several sets,
 * dev data) and re-adds the cascade FK and keys. It is only valid together with reverting the stage 6b
 * application code, which no longer writes the column.
 */

const TABLES = [
  { table: 'product_periodical_snapshots', abbr: 'prperiod', junction: 'product_set_periodical_snapshots', col: 'product_periodical_snapshot_id' },
  { table: 'product_oneoff_snapshots', abbr: 'proneoff', junction: 'product_set_oneoff_snapshots', col: 'product_oneoff_snapshot_id' },
  { table: 'product_session_snapshots', abbr: 'prsess', junction: 'product_set_session_snapshots', col: 'product_session_snapshot_id' },
];

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`, [table, name]);
  return rows.length > 0;
}

async function hasForeignKey(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`, [table, name]);
  return rows.length > 0;
}

exports.up = async (knex) => {
  for (const { table, abbr, junction, col } of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'product_set_id'))) continue;
    await knex.raw(`
      INSERT IGNORE INTO ${junction} (product_set_id, ${col})
      SELECT s.product_set_id, s.id
        FROM ${table} s
        JOIN product_sets ps ON ps.id = s.product_set_id
       WHERE NOT EXISTS (SELECT 1 FROM ${junction} j WHERE j.${col} = s.id)
       ORDER BY s.id`);
    if (await hasForeignKey(knex, table, `${abbr}_set_fk`)) {
      await knex.raw(`ALTER TABLE ${table} DROP FOREIGN KEY ${abbr}_set_fk`);
    }
    if (await hasIndex(knex, table, `${abbr}_set_index`)) {
      await knex.raw(`ALTER TABLE ${table} DROP KEY ${abbr}_set_index`);
    }
    if (abbr === 'prperiod') {
      if (await hasIndex(knex, table, 'prperiod_line_index')) {
        await knex.raw(`ALTER TABLE ${table} DROP KEY prperiod_line_index`);
      }
      if (!(await hasIndex(knex, table, 'prperiod_line_ref_index'))) {
        await knex.raw(`ALTER TABLE ${table} ADD KEY prperiod_line_ref_index (gym_id, line_ref)`);
      }
    }
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN product_set_id`);
  }
};

exports.down = async (knex) => {
  for (const { table, abbr, junction, col } of TABLES) {
    if (await hasForeignKey(knex, table, `${abbr}_set_fk`)) continue;
    if (!(await knex.schema.hasColumn(table, 'product_set_id'))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN product_set_id INT UNSIGNED NULL AFTER member_id`);
    }
    await knex.raw(`
      UPDATE ${table} s
        JOIN (SELECT ${col} AS snap_id, MIN(product_set_id) AS set_id FROM ${junction} GROUP BY ${col}) j
          ON j.snap_id = s.id
         SET s.product_set_id = j.set_id`);
    if (abbr === 'prperiod') {
      if (await hasIndex(knex, table, 'prperiod_line_ref_index')) {
        await knex.raw(`ALTER TABLE ${table} DROP KEY prperiod_line_ref_index`);
      }
      if (!(await hasIndex(knex, table, 'prperiod_line_index'))) {
        await knex.raw(`ALTER TABLE ${table} ADD KEY prperiod_line_index (product_set_id, line_ref)`);
      }
    }
    if (!(await hasIndex(knex, table, `${abbr}_set_index`))) {
      await knex.raw(`ALTER TABLE ${table} ADD KEY ${abbr}_set_index (product_set_id)`);
    }
    await knex.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${abbr}_set_fk FOREIGN KEY (product_set_id) REFERENCES product_sets (id) ON DELETE CASCADE`);
  }
};
