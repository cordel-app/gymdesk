/**
 * #2125 M6b-51d-1 — one allocator for Membership Plan assignment ids.
 *
 * An assignment's public id (`/user-memberships/:id`, `payment_requests.user_membership_id`,
 * `plan_snapshots.source_user_membership_id`, the audit log's `entity_id`) was allocated by
 * `user_memberships`' own AUTO_INCREMENT. That table is being retired (Oscar, 2026-11-20: "eliminate
 * `user_memberships` entirely"), so the ids need an allocator that survives it, and every id already
 * handed out must keep working. Option 1 of the 2026-11-22 03:11Z question on #2125, the
 * `product_purchase_ids` precedent (#2126 stage 5d-3, migration 413).
 *
 * `plan_assignment_ids` is that allocator and a registry: one row per assignment id ever handed out.
 * `insertAssignment()` (`api/assignment-lifecycle-writer.ts`) inserts a row, uses its id as the
 * assignment's, and writes the legacy row under it, so `user_memberships` no longer allocates.
 *
 * The backfill registers every historical id (the legacy rows and every `source_user_membership_id`
 * a plan snapshot names); no assignment row is rewritten. AUTO_INCREMENT is then moved above every id
 * either source has handed out — the legacy table's own counter included, which covers a deleted
 * Draft — plus a headroom for the deploy window (the previous API container still lets the legacy
 * table allocate while this runs). `ALTER TABLE … AUTO_INCREMENT` on this new table is a metadata change.
 *
 * `down` drops the table: the legacy row still holds every assignment id the writer handed out. Roll
 * the API back with it — `insertAssignment()` allocates here and has no fallback.
 */

const DEPLOY_HEADROOM = 1000;

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('plan_assignment_ids'))) {
    await knex.raw(`
      CREATE TABLE plan_assignment_ids (
        id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id     CHAR(36)     NOT NULL,
        created_at DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        KEY idx_pai_gym (gym_id),
        CONSTRAINT fk_pai_gym FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  await knex.raw(`
    INSERT IGNORE INTO plan_assignment_ids (id, gym_id, created_at)
    SELECT id, gym_id, created_at FROM user_memberships`);
  await knex.raw(`
    INSERT IGNORE INTO plan_assignment_ids (id, gym_id, created_at)
    SELECT source_user_membership_id, gym_id, MIN(created_at) FROM plan_snapshots
     WHERE source_user_membership_id IS NOT NULL
     GROUP BY source_user_membership_id, gym_id`);

  const [rows] = await knex.raw('SELECT COALESCE(MAX(id), 0) AS top FROM plan_assignment_ids');
  // MAX(id) misses an id whose legacy row was deleted (InnoDB keeps the counter), so the legacy
  // table's own counter is read too — fresh, since MySQL 8 otherwise serves a cached value.
  await knex.raw('SET SESSION information_schema_stats_expiry = 0');
  const [counter] = await knex.raw(
    `SELECT AUTO_INCREMENT AS ai FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_memberships'`);
  const next = Math.max(Number(rows[0].top) + 1, Number(counter[0]?.ai ?? 0)) + DEPLOY_HEADROOM;
  if (!Number.isSafeInteger(next) || next < 1) throw new Error(`migration 455: unexpected id ${rows[0].top}`);
  await knex.raw(`ALTER TABLE plan_assignment_ids AUTO_INCREMENT = ${next}`);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE IF EXISTS plan_assignment_ids');
};
