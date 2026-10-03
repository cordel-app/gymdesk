/**
 * #948 §4 — **Assigned Personal Goals**: the Personal Goals a member actually
 * holds, as opposed to the ones the gym's library offers.
 *
 * ── What a row holds, and why ───────────────────────────────────────────────
 *
 * The thread's Q2 answer is the specification: besides `(member_id,
 * personal_goal_id)` a row carries a **target value + unit** ("lose 5 kg"), a
 * **start date and a target date**, a **status** (in progress / achieved /
 * abandoned), **free-text notes** and the #799 actor snapshot pairs — "yes" to
 * all of them, **many** per member. Nothing here is derived and nothing is
 * priced, so every column is exactly what staff typed.
 *
 * ── The progress status and the soft delete are two different columns ───────
 *
 * `status` is the *progress* of the goal, and `deleted_at` is whether the
 * assignment exists at all. Folding deletion into the status vocabulary — which
 * is what the goal **catalogue** does (migration 206: `status IN ('active',
 * 'deleted')`, where there is no second axis to lose) — would overwrite the one
 * fact the row is about: a goal deleted after being achieved would read back as
 * neither. So this table takes `members`' own shape instead, `deleted_at IS
 * NULL` as the live predicate, with the actor pair recording who deleted it.
 *
 * ── `personal_goal_id` points at the catalogue, System rows included ────────
 *
 * The catalogue is the shared-platform-catalogue shape (`gym_id IS NULL` = a
 * System row administered from Cordel, non-NULL = that gym's own), so an
 * assignment may name either and the router is what checks visibility —
 * `(gym_id IS NULL OR gym_id = ?)` on the way in, exactly as a gym-facing read
 * of the catalogue does. The FK cannot express that, and must not try: a CHECK
 * comparing two tables does not exist in MySQL, and a redundant `goal_gym_id`
 * column would be a second copy of the catalogue's ownership.
 *
 * Both FKs are `ON DELETE CASCADE`. The catalogue soft-deletes, so the cascade
 * on `personal_goal_id` only ever fires when the **gym** is deleted and its
 * rows go with it — `RESTRICT` there would make that gym delete fail, since
 * MySQL does not order the cascades one DELETE fans out into.
 *
 * ── One live, in-progress assignment per (member, goal) ─────────────────────
 *
 * "Many per member" is many *goals*, not the same goal pursued twice at once:
 * two **in-progress** Weight Loss rows with different targets are a data-entry
 * mistake with no reading that makes them both true. So the constraint is on the
 * live, in-progress pair and deliberately on nothing wider — an achieved or
 * abandoned goal may be assigned again, which is what makes the status
 * transitions useful, and two *finished* records of the same goal are ordinary
 * history (a member who hit a weight target in the spring and again in the
 * autumn), not a duplicate. That is also why `POST` accepts a status: staff
 * recording a goal that is already behind them is a real case, and it cannot
 * open a hole, because moving such a row to `in_progress` later goes through the
 * very same index and answers 409.
 *
 * It is the migration-183/206 device: a VIRTUAL generated column that is
 * non-NULL only while the row is live and in progress, carrying the UNIQUE
 * index, so the index and the router's own 409 agree by construction rather than
 * by discipline. VIRTUAL rather than STORED because MySQL rejects a STORED
 * generated column over a foreign-key column.
 *
 * Every statement is guarded on its own: MySQL commits DDL implicitly, so a
 * crash between two of them must not make a re-run skip one (migrations
 * 134/140/155/183/205/206).
 */

/** Mirrors `PERSONAL_GOAL_ASSIGNMENT_STATUSES` in `api/src/domain/personalGoalAssignment.ts`. */
const STATUSES = ['in_progress', 'achieved', 'abandoned'];

/**
 * The prefix every constraint and index on the table is named with. `mpgoal`
 * rather than `mpg` because CHECK and FK names are schema-global in MySQL 8, and
 * it is the `pgoal`/`ngoal` pair migration 206 already chose, one table over.
 */
const PREFIX = 'mpgoal';
const TABLE = 'member_personal_goals';

async function hasIndex(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, name],
  );
  return Number(rows[0].cnt) > 0;
}

exports.up = async (knex) => {
  const statuses = STATUSES.map((s) => `'${s}'`).join(', ');

  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        gym_id           CHAR(36)      NOT NULL,
        member_id        INT UNSIGNED  NOT NULL,
        personal_goal_id INT UNSIGNED  NOT NULL,
        target_value     DECIMAL(10,2) NULL,
        target_unit      VARCHAR(20)   NULL,
        start_date       DATE          NULL,
        target_date      DATE          NULL,
        status           VARCHAR(20)   NOT NULL DEFAULT 'in_progress',
        notes            VARCHAR(1000) NULL,
        created_at       DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at      DATETIME      NULL,
        deleted_at       DATETIME      NULL,
        created_by_name  VARCHAR(255)  NULL,
        created_by_type  VARCHAR(20)   NULL,
        modified_by_name VARCHAR(255)  NULL,
        modified_by_type VARCHAR(20)   NULL,
        deleted_by_name  VARCHAR(255)  NULL,
        deleted_by_type  VARCHAR(20)   NULL,
        live_goal_key    VARCHAR(64)   COLLATE utf8mb4_bin GENERATED ALWAYS AS (
                           IF(deleted_at IS NULL AND status = 'in_progress',
                              CONCAT(member_id, ':', personal_goal_id), NULL)
                         ) VIRTUAL,
        PRIMARY KEY (id),
        UNIQUE KEY ${PREFIX}_live_goal_key (live_goal_key),
        -- deleted_at sits second in both: the list the Assigned Personal Goals
        -- page opens on constrains gym_id and deleted_at and nothing else, so a
        -- third-position deleted_at would leave it filtering every row the gym
        -- has ever had on the heap.
        KEY ${PREFIX}_gym_live_index (gym_id, deleted_at, member_id),
        KEY ${PREFIX}_gym_status_index (gym_id, deleted_at, status),
        -- Declared rather than left to InnoDB, which would otherwise auto-create
        -- one named after the constraint: the FK one column over has the same.
        KEY ${PREFIX}_member_index (member_id),
        KEY ${PREFIX}_goal_index (personal_goal_id),
        CONSTRAINT ${PREFIX}_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT ${PREFIX}_member_fk FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
        CONSTRAINT ${PREFIX}_goal_fk FOREIGN KEY (personal_goal_id) REFERENCES personal_goals(id) ON DELETE CASCADE,
        CONSTRAINT chk_${PREFIX}_status CHECK (status IN (${statuses})),
        CONSTRAINT chk_${PREFIX}_target_value CHECK (target_value IS NULL OR target_value >= 0),
        -- A unit answers "5 of what"; with no value there is nothing for it to
        -- qualify, so the pair is refused in SQL and not only by the router. The
        -- converse is deliberately allowed: a value with no unit ("lose 5") is
        -- incomplete, not contradictory, and goalAssignmentFieldError() checks
        -- the same one direction - do not "complete" either of them.
        CONSTRAINT chk_${PREFIX}_target_unit CHECK (target_unit IS NULL OR target_value IS NOT NULL),
        CONSTRAINT chk_${PREFIX}_dates
          CHECK (target_date IS NULL OR start_date IS NULL OR target_date >= start_date),
        CONSTRAINT chk_${PREFIX}_created_by_type
          CHECK (created_by_type IS NULL OR created_by_type IN ('staff','superadmin')),
        CONSTRAINT chk_${PREFIX}_modified_by_type
          CHECK (modified_by_type IS NULL OR modified_by_type IN ('staff','superadmin')),
        CONSTRAINT chk_${PREFIX}_deleted_by_type
          CHECK (deleted_by_type IS NULL OR deleted_by_type IN ('staff','superadmin'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // Defensive, for a database where an earlier partial run left the table
  // without its generated column or its unique index (the CREATE above is one
  // statement, so this can only happen if someone built the table by hand).
  // The column is repaired **first**: indexing one that is not there throws
  // ER_BAD_FIELD_ERROR with the table already created, which is the partial
  // state this guard exists to avoid.
  if (!(await knex.schema.hasColumn(TABLE, 'live_goal_key'))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD COLUMN live_goal_key VARCHAR(64) COLLATE utf8mb4_bin `
      + "GENERATED ALWAYS AS (IF(deleted_at IS NULL AND status = 'in_progress', "
      + "CONCAT(member_id, ':', personal_goal_id), NULL)) VIRTUAL",
    );
  }
  if (!(await hasIndex(knex, TABLE, `${PREFIX}_live_goal_key`))) {
    await knex.raw(`CREATE UNIQUE INDEX ${PREFIX}_live_goal_key ON ${TABLE} (live_goal_key)`);
  }
};

exports.down = async (knex) => {
  // Nothing references this table, so dropping it loses only the assignments —
  // which is what a `down` of an assignment-creating migration means. The
  // catalogues it points at (migration 206) are untouched.
  await knex.schema.dropTableIfExists(TABLE);
};

exports.TABLE = TABLE;
exports.PREFIX = PREFIX;
exports.STATUSES = STATUSES;
