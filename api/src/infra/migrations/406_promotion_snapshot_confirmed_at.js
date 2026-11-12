/**
 * #2624 stage 4 (§8): a Promotion applied to a **Draft** is captured for good only
 * when the Draft is confirmed (Save & Pay, or the free commit). Until then the
 * application's `snapshot` and grant snapshot rows are a working copy the engine
 * prices the Draft from, re-taken from the live Promotion at confirmation.
 *
 * `snapshot_confirmed_at` records that confirmation: NULL = a working copy that
 * the next confirmation of its Draft re-captures, set = the historical record
 * that nothing rewrites. Backfill: every application that is not on a Draft is
 * confirmed (its `applied_at`), and so is one a clone Draft copied from its
 * predecessor (applied before the Draft existed); only what was applied on a
 * Draft still being configured stays NULL. Re-entrant.
 */
const TABLE = 'user_membership_promotions';
const COLUMN = 'snapshot_confirmed_at';

const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`, [TABLE, COLUMN]);
  return rows.length > 0;
};

exports.up = async (knex) => {
  if (!(await hasColumn(knex))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} DATETIME NULL`);
  }
  await knex.raw(
    `UPDATE ${TABLE} ump
       LEFT JOIN product_sets ps ON ps.id = ump.product_set_id
        SET ump.${COLUMN} = COALESCE(ump.applied_at, UTC_TIMESTAMP())
      WHERE ump.${COLUMN} IS NULL
        AND (ps.id IS NULL OR ps.status <> 'draft' OR ump.applied_at < ps.created_at)`);
};

exports.down = async (knex) => {
  if (await hasColumn(knex)) await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
};
