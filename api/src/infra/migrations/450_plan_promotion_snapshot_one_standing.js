/**
 * #3026 stage 3d-1: one standing application per Promotion and plan snapshot, enforced by the
 * database.
 *
 * `plan_promotion_snapshots.standing_key` (migration 347) is `plan_snapshot_id:promotion_id` while
 * the row is `applied` and NULL otherwise, but its index was not unique: the backstop against two
 * concurrent applies lived on `user_membership_promotions` (`ump_one_standing_per_set_promotion`),
 * which no longer receives a Plan application. The index becomes UNIQUE.
 *
 * A snapshot that already holds two standing rows of one Promotion (none is expected: the
 * derivation was keyed per legacy application) keeps the oldest; the others become `superseded`,
 * which every pricing reader ignores, so the index can be built. Re-entrant; `down` restores the
 * plain index.
 */
const INDEX = 'plan_promotion_snapshots_standing';

async function indexIsUnique(knex) {
  const [rows] = await knex.raw(
    `SELECT NON_UNIQUE FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plan_promotion_snapshots' AND INDEX_NAME = ?`, [INDEX]);
  return rows.length > 0 && Number(rows[0].NON_UNIQUE) === 0;
}

exports.up = async (knex) => {
  if (await indexIsUnique(knex)) return;
  await knex.raw(
    `UPDATE plan_promotion_snapshots d
       JOIN (SELECT plan_snapshot_id, promotion_id, MIN(id) AS keep_id
               FROM plan_promotion_snapshots WHERE status = 'applied'
              GROUP BY plan_snapshot_id, promotion_id HAVING COUNT(*) > 1) k
         ON k.plan_snapshot_id = d.plan_snapshot_id AND k.promotion_id = d.promotion_id
        SET d.status = 'superseded', d.modified_at = UTC_TIMESTAMP(), d.modified_by = 'System'
      WHERE d.status = 'applied' AND d.id <> k.keep_id`);
  await knex.raw(`ALTER TABLE plan_promotion_snapshots DROP INDEX ${INDEX}, ADD UNIQUE INDEX ${INDEX} (standing_key)`);
};

exports.down = async (knex) => {
  if (!(await indexIsUnique(knex))) return;
  await knex.raw(`ALTER TABLE plan_promotion_snapshots DROP INDEX ${INDEX}, ADD INDEX ${INDEX} (standing_key)`);
};
