/**
 * #1181 — `gym_personal_goals`: a gym's own availability state for each
 * Personal Goal it can see.
 *
 * A System Personal Goal (`personal_goals.gym_id IS NULL`) is one row shared by
 * every gym, so "Gym A does not want Weight Loss" cannot be written on it — that
 * is `gym_professional_services`' reason (migration 140), and this table is the
 * same shape one catalogue over: the global definition stays in
 * `personal_goals`, the per-gym state lives here, keyed UNIQUE on
 * `(gym_id, personal_goal_id)`. It is valid for the gym's own goals too, which
 * exist in one gym only, so their configuration is naturally scoped.
 *
 * Three things are the rule rather than the implementation:
 *
 *  * **No row means active.** Every reader resolves `COALESCE(gpg.status,
 *    'active')` (`gymGoalStatusSql()` in `api/src/domain/goalLibrary.ts`), so a
 *    System goal Cordel adds *after* this migration is available to every gym
 *    without a writer having to visit every gym — the ticket's "a System Goal
 *    with no explicit configuration must not silently become unavailable". The
 *    backfill below still writes an `active` row per (gym, visible goal), as
 *    the ticket asks, and gym creation seeds one per System goal (`gyms.ts`),
 *    so the configuration is explicit wherever it can be and safe where it
 *    is not.
 *  * **The status is an availability axis, not a lifecycle.** `active |
 *    inactive` here says whether this gym offers the goal for new assignments;
 *    `personal_goals.status` (`active | deleted`) says whether the definition
 *    exists. Deactivating touches nothing on `personal_goals` and nothing on
 *    `member_personal_goals` — an existing assignment is a snapshot (#1034)
 *    and stays exactly as it is.
 *  * **The actor pairs are #799's snapshot**, as on `personal_goals`: a
 *    superadmin acting directly has no `gym_memberships` row to join to.
 *
 * Raw SQL rather than the knex builder, for 206's and 229's reason: one
 * `CREATE TABLE` carrying its named CHECKs and FKs is a single statement, so
 * the one `hasTable()` guard is exact — the builder would emit CREATE plus
 * separate ALTERs, and a crash between them leaves a table a re-run skips for
 * good (231's header has the whole failure). The short `gpg_*` prefix is 206's
 * convention (CHECK and FK names are schema-global in MySQL 8).
 *
 * **Cost.** One new table and two INSERT … SELECT backfills — gyms × System
 * goals (seven per gym) plus each gym's own goals — tens of rows per gym.
 * No existing table is altered, so no rebuild and no window. `INSERT IGNORE`
 * under the UNIQUE key makes a re-run a no-op.
 */

const TABLE = 'gym_personal_goals';

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
        gym_id            CHAR(36)     NOT NULL,
        personal_goal_id  INT UNSIGNED NOT NULL,
        status            VARCHAR(20)  NOT NULL DEFAULT 'active',
        created_at        DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by_name   VARCHAR(255) NULL,
        created_by_type   VARCHAR(20)  NULL,
        modified_at       DATETIME     NULL,
        modified_by_name  VARCHAR(255) NULL,
        modified_by_type  VARCHAR(20)  NULL,
        PRIMARY KEY (id),
        UNIQUE KEY gpg_gym_goal_unique (gym_id, personal_goal_id),
        KEY gpg_goal_idx (personal_goal_id),
        CONSTRAINT gpg_gym_fk  FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT gpg_goal_fk FOREIGN KEY (personal_goal_id) REFERENCES personal_goals(id) ON DELETE CASCADE,
        CONSTRAINT chk_gpg_status CHECK (status IN ('active','inactive')),
        CONSTRAINT chk_gpg_created_by_type
          CHECK (created_by_type IS NULL OR created_by_type IN ('staff','superadmin')),
        CONSTRAINT chk_gpg_modified_by_type
          CHECK (modified_by_type IS NULL OR modified_by_type IN ('staff','superadmin'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // Backfill: every existing gym gets an explicit `active` row for every
  // System goal, and every gym-owned goal gets one for its own gym. Deleted
  // definitions are skipped — nothing can be assigned from them anyway. Soft-
  // deleted gyms are included on purpose: the cost is a handful of rows each
  // and the FK cascades on a hard delete, so every gym carries the same
  // explicit state regardless of lifecycle — not because a missing row would
  // make anything unavailable (it would not; see the COALESCE rule above).
  // 140 excluded them; this diverges knowingly.
  //
  // INSERT IGNORE rather than 206's keyed skip: the ids come from the
  // referenced tables and the literal is in the CHECK set, so the duplicate
  // key is the only error it can hide — and never ON DUPLICATE KEY UPDATE,
  // because a recovery re-run must not flip a row a gym has since set
  // `inactive`.
  await knex.raw(`
    INSERT IGNORE INTO ${TABLE} (gym_id, personal_goal_id, status)
    SELECT g.id, pg.id, 'active'
    FROM gyms g
    JOIN personal_goals pg ON pg.gym_id IS NULL AND pg.status <> 'deleted'
  `);
  await knex.raw(`
    INSERT IGNORE INTO ${TABLE} (gym_id, personal_goal_id, status)
    SELECT pg.gym_id, pg.id, 'active'
    FROM personal_goals pg
    WHERE pg.gym_id IS NOT NULL AND pg.status <> 'deleted'
  `);
};

exports.down = async (knex) => {
  // Roll the application half back first: `gymGoalStatusSql()` names this
  // table inside a correlated subquery, so dropping it under a deployed API
  // answers ER_NO_SUCH_TABLE — a bare 500 (#966) — on every goal catalogue
  // read, both assignment paths and the member's `/available`. Once the
  // readers no longer ask, every visible goal is available again by
  // construction. Nothing on `personal_goals` or `member_personal_goals` was
  // ever written by this migration.
  await knex.schema.dropTableIfExists(TABLE);
};
