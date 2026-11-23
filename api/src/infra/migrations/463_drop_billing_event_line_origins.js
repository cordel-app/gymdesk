/**
 * #3122 — reverts stage 1 (migration 445): a Billing Event Line no longer records the contractual
 * snapshot that originated it. The owner reconsidered ProductSet's role as the holder of contractual
 * composition (comment of 2026-11-20 on #3122), so line-level attribution is dropped rather than kept
 * as a second record of it. Only the two pointers, their foreign keys and their indexes go; every
 * economic value of every line is untouched. Each step is guarded, so an interrupted run can re-run.
 */
const TABLE = 'billing_event_lines';
const FKS = [
  ['fk_bel_plan_snapshot', 'plan_snapshot_id', 'plan_snapshots'],
  ['fk_bel_prperiod_snapshot', 'product_periodical_snapshot_id', 'product_periodical_snapshots'],
];
const IDXS = [['idx_bel_plan_snapshot', 'plan_snapshot_id'], ['idx_bel_prperiod_snapshot', 'product_periodical_snapshot_id']];

const fkExists = async (knex, name) => (await knex.raw(
  `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`, [TABLE, name]))[0].length > 0;
const idxExists = async (knex, name) => (await knex.raw(
  `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ? AND INDEX_NAME = ?`, [TABLE, name]))[0].length > 0;

exports.up = async (knex) => {
  for (const [fk] of FKS) if (await fkExists(knex, fk)) await knex.raw(`ALTER TABLE ${TABLE} DROP FOREIGN KEY ${fk}`);
  for (const [ix] of IDXS) if (await idxExists(knex, ix)) await knex.raw(`ALTER TABLE ${TABLE} DROP KEY ${ix}`);
  for (const [, col] of FKS) if (await knex.schema.hasColumn(TABLE, col)) await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${col}`);
};

exports.down = async (knex) => {
  for (const [, col] of FKS) {
    if (!(await knex.schema.hasColumn(TABLE, col))) await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${col} INT UNSIGNED NULL`);
  }
  for (const [ix, col] of IDXS) if (!(await idxExists(knex, ix))) await knex.raw(`ALTER TABLE ${TABLE} ADD KEY ${ix} (${col})`);
  for (const [fk, col, ref] of FKS) {
    if (!(await fkExists(knex, fk))) {
      await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${fk} FOREIGN KEY (${col}) REFERENCES ${ref} (id) ON DELETE SET NULL`);
    }
  }
};
