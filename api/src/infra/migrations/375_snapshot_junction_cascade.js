/**
 * #2125 / #2126 M2 — the snapshot side of every junction (migration 366) becomes ON DELETE CASCADE.
 *
 * 366 made it RESTRICT to express that a snapshot is immutable. While a snapshot is still also owned by
 * its Product Set through its own `product_set_id` (cascade from `product_sets`), a RESTRICT junction
 * makes `DELETE FROM product_sets` (discarding or expiring a Draft, deleting a gym) fail: InnoDB does not
 * order the two cascades. So the junction row follows the snapshot until M4 makes snapshots independent
 * of one Product Set; whether a snapshot may be deleted is the application's rule (nothing edits or
 * deletes a snapshot a committed Product Set uses), not this FK's.
 *
 * Repeatable: each junction is changed only while its snapshot FK is not yet CASCADE. `down` restores
 * RESTRICT.
 */
const JUNCTIONS = [
  ['product_set_plan_snapshots', 'psps', 'plan_snapshot_id', 'plan_snapshots'],
  ['product_set_session_snapshots', 'pssn', 'product_session_snapshot_id', 'product_session_snapshots'],
  ['product_set_oneoff_snapshots', 'psosn', 'product_oneoff_snapshot_id', 'product_oneoff_snapshots'],
  ['product_set_periodical_snapshots', 'pspsn', 'product_periodical_snapshot_id', 'product_periodical_snapshots'],
  ['billing_event_oneoff_snapshots', 'beosn', 'product_oneoff_snapshot_id', 'product_oneoff_snapshots'],
];

async function deleteRule(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT DELETE_RULE AS r FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`, [table, name]);
  return rows[0] ? rows[0].r : null;
}

async function setRule(knex, rule) {
  for (const [table, abbr, col, snapTable] of JUNCTIONS) {
    if (!(await knex.schema.hasTable(table))) continue;
    const name = `${abbr}_snapshot_fk`;
    const current = await deleteRule(knex, table, name);
    if (current === rule) continue;
    if (current != null) await knex.raw(`ALTER TABLE ${table} DROP FOREIGN KEY ${name}`);
    await knex.raw(
      `ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (${col}) REFERENCES ${snapTable} (id) ON DELETE ${rule}`);
  }
}

exports.up = (knex) => setRule(knex, 'CASCADE');
exports.down = (knex) => setRule(knex, 'RESTRICT');
