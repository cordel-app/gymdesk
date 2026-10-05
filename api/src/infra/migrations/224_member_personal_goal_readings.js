/**
 * #1037 stage 2 — **readings**: the measurements an Assigned Personal Goal
 * accumulates over time, and the initial readings each of them is measured
 * from.
 *
 * `member_personal_goals` (migration 212) records what was *agreed* — the
 * target, the dates, the progress status someone chose. What it has never
 * recorded is what the member actually weighed, lifted or ran, so a card could
 * show a target and nothing to compare it with. This table is that history:
 * one row per measurement, append-only, and the assignment's `initial_reading`,
 * `latest_reading` and `progress_percent` are **derived from it on read**
 * (`api/src/domain/goalReadings.ts`) rather than stored beside the target —
 * §11's "must update automatically whenever a new reading is added" is a
 * statement about a computed field, and a stored copy would need a writer in
 * every path that adds a reading and would be wrong the first time one was
 * missed.
 *
 * ── One table, not two: `is_initial` is the period boundary ────────────────
 *
 * §21/§22 require that changing the initial reading **creates a new effective
 * period** rather than overwriting the old value, and §37 sketches that as a
 * second table (`value`, `effective_from`). It is one table here, and the
 * ticket's own §37 says why that satisfies it: what it asks for is the
 * *capability* — "which initial reading was active at any point in time?" — and
 * a flag on the reading answers it exactly. Three reasons it is the better
 * shape:
 *
 * * **The value would otherwise be stored twice.** §1 and §29 both put the
 *   initial reading *in* the reading history ("01 Sep 80 Kg Initial", "22 Sep
 *   76 Kg New initial reading"), so a separate period row holding its own
 *   `value` is a second copy of a number the history already carries, free to
 *   drift from it with nothing in SQL able to tie them together.
 * * **An `effective_from` of its own could contradict the reading.** A period
 *   effective 22 Sep established by a measurement taken on the 25th would place
 *   that measurement in the *previous* period while the period it starts began
 *   earlier. With the flag the two are one timestamp and the contradiction is
 *   unexpressible.
 * * **Period assignment becomes an ordering question** (§38): a reading belongs
 *   to the last initial-flagged reading at or before it, which is one `ORDER
 *   BY` and no join. `assignReadingPeriods()` is the one place that decides it.
 *
 * So "the initial-reading history" is `WHERE is_initial = 1 ORDER BY
 * recorded_at`, and the **active** initial reading is its last row — which is
 * what §25 requires progress to be computed from, and why a superseded initial
 * reading is never updated or deleted (§28).
 *
 * ── Append-only, deliberately ──────────────────────────────────────────────
 *
 * §34 asks for adding and viewing readings and for no edit or delete, so there
 * is no `deleted_at`, no `modified_at` and no `modified_by` pair: a row records
 * that a measurement was taken, and correcting one is a decision (does the
 * chart lose a point? does a superseded initial period vanish?) that needs its
 * own ticket. The `created_by` pair is #799's snapshot and admits `member`
 * as migration 222 already does for the assignment itself (`Q3` on the thread:
 * readings are added from **both** sides, so the row has to say which).
 *
 * ── No backfill ────────────────────────────────────────────────────────────
 *
 * An assignment that exists today has no reading, and nothing can invent one:
 * the agreed `target_value` is where the member is *going*, not where they
 * started, and `start_date` says when without saying what. So a goal with no
 * readings reports `initial_reading: null`, `latest_reading: null` and
 * `progress_percent: null`, the card shows `—`, and the first reading somebody
 * records fills it. That is migration 218's and 222's reasoning for their own
 * nullable snapshots, applied to a whole table.
 *
 * ── Scale and sign mirror the target ───────────────────────────────────────
 *
 * `value` is `DECIMAL(10,2)` with `CHECK (value >= 0)` — the same type and the
 * same bound as `member_personal_goals.target_value` (migration 212), because a
 * reading and a target are quantities of the same thing in the same unit, and a
 * reading the column could hold but the target could not would make progress
 * incomputable in one direction. The unit itself is **not** repeated here: it
 * belongs to the assignment (§3 — "the unit must be inherited from the assigned
 * goal", and §9 that it comes from the goal), and a per-reading unit would be a
 * second, incompatible unit system of exactly the kind #1034 §1 forbids.
 *
 * Every statement is guarded on its own: MySQL commits DDL implicitly, so a
 * crash between two of them must leave a state a re-run recomputes from
 * (migrations 134/140/155/183/205/206/212/217/218/222).
 */

const TABLE = 'member_personal_goal_readings';

/**
 * The prefix every constraint and index on the table is named with. CHECK and
 * FK names are schema-global in MySQL 8, not table-scoped, which is why
 * migration 212 prefixed every one of its own — `mpgr` is that `mpgoal` one
 * table over.
 */
const PREFIX = 'mpgr';

/** Mirrors `ASSIGNMENT_ACTOR_TYPES` in `api/src/domain/personalGoalAssignment.ts`. */
const ACTOR_TYPES = ['staff', 'superadmin', 'member'];

exports.up = async (knex) => {
  const actors = ACTOR_TYPES.map((t) => `'${t}'`).join(', ');

  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id                      INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        gym_id                  CHAR(36)      NOT NULL,
        member_personal_goal_id INT UNSIGNED  NOT NULL,
        value                   DECIMAL(10,2) NOT NULL,
        recorded_at             DATETIME      NOT NULL,
        is_initial              TINYINT(1)    NOT NULL DEFAULT 0,
        created_at              DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by_name         VARCHAR(255)  NULL,
        created_by_type         VARCHAR(20)   NULL,
        PRIMARY KEY (id),
        -- The one read this table has: every reading of one assignment, in the
        -- order the chart and the history both need (§17/§19 are the same rows
        -- read in opposite directions). \`id\` rides along as the tie-breaker,
        -- because §33 allows several readings on one date and the pair is what
        -- makes their order total.
        KEY ${PREFIX}_goal_time_index (member_personal_goal_id, recorded_at, id),
        -- The initial-reading history (§22) and the active initial reading
        -- (§25): the same rows narrowed to the period boundaries.
        KEY ${PREFIX}_goal_initial_index (member_personal_goal_id, is_initial, recorded_at),
        -- Declared rather than left to InnoDB, which would otherwise auto-create
        -- one named after the constraint.
        KEY ${PREFIX}_gym_index (gym_id),
        CONSTRAINT ${PREFIX}_gym_fk FOREIGN KEY (gym_id)
          REFERENCES gyms(id) ON DELETE CASCADE,
        -- CASCADE, so a gym's deletion reaches these through either FK and an
        -- assignment hard-deleted with its member takes its readings with it.
        -- The assignment's own removal is a **soft** delete, which touches
        -- nothing here: §28's historical readings survive it, and re-assigning
        -- the goal creates a new assignment with its own history.
        CONSTRAINT ${PREFIX}_assignment_fk FOREIGN KEY (member_personal_goal_id)
          REFERENCES member_personal_goals(id) ON DELETE CASCADE,
        CONSTRAINT chk_${PREFIX}_value CHECK (value >= 0),
        CONSTRAINT chk_${PREFIX}_is_initial CHECK (is_initial IN (0, 1)),
        CONSTRAINT chk_${PREFIX}_created_by_type
          CHECK (created_by_type IS NULL OR created_by_type IN (${actors}))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }
};

exports.down = async (knex) => {
  // Dropping the table destroys every measurement recorded since deploy, and a
  // later `up()` creates an empty one — there is nothing else a `down` of a
  // history table can do, and it is written here so the next reader does not
  // mistake this one for reversible. The assignments it hangs off (migration
  // 212) are untouched and simply read as having no readings again.
  await knex.schema.dropTableIfExists(TABLE);
};

exports.TABLE = TABLE;
exports.PREFIX = PREFIX;
exports.ACTOR_TYPES = ACTOR_TYPES;
