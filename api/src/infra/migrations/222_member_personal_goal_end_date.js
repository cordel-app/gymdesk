/**
 * #1036 §Q4 — a member may remove a Personal Goal they hold, and the ones that
 * are over read as **Past Goals**: "an assigned personal goal will store
 * start_date, end_date and status".
 *
 * ── `end_date`: when the assignment stopped, not when it was meant to ───────
 *
 * The table already carries `start_date` (when the member started pursuing the
 * goal) and `target_date` (when they *meant* to reach it, migration 212). What
 * neither records is when it actually ended, and a Past Goals list that cannot
 * say that shows a member three finished goals with no dates on any of them.
 * So the column is the third date and deliberately not a renaming of the
 * second: a goal abandoned in March with a target date in June has both, and
 * they say different things.
 *
 * It is **written by the server, never submitted**: `endDateTransition()` in
 * `api/src/domain/personalGoalAssignment.ts` is the one place that decides it,
 * stamping the day an assignment stops being live-and-in-progress (removed, or
 * moved to `achieved`/`abandoned`) and clearing it if it comes back. A client
 * field would be a fourth date to validate against the other three and a way to
 * claim an assignment ended on a day it did not — and the staff and member
 * routers would then have to agree about it twice.
 *
 * NULLable with **no backfill**, which is the shape every snapshot column in
 * this codebase takes (#635 §16, migration 218's `goal_name`): a row that ended
 * before this migration has no end date to recover — `modified_at` is the last
 * time *anything* on it changed, not the day it stopped — so inventing one
 * would claim a fact the database never recorded. `—` is a legitimate end date
 * for a legacy Past Goal, and the first real transition fills it.
 *
 * It is deliberately **not** added to `chk_mpgoal_dates`, which guards
 * `target_date >= start_date`. `endDateTransition()` stamps *today*, and staff
 * may set a future `start_date`, so a member removing such a goal the same
 * afternoon legitimately produces `end_date < start_date` — the goal really did
 * end before it was due to begin. Constraining it would turn that into a 500.
 *
 * ── `'member'` joins the three actor-type CHECKs ───────────────────────────
 *
 * #799's actor pairs were written when only staff could touch an assignment, so
 * `chk_mpgoal_*_by_type` admits `staff` and `superadmin` only. A member
 * assigning a goal to themselves (#1036 §4) is a third kind of actor, and
 * leaving the pair NULL for them would make a member-created row
 * indistinguishable from a row created before the columns existed. Widening the
 * CHECK is what lets `memberActorSnapshot()` record who actually acted.
 *
 * A superadmin impersonating a member still records `superadmin`: the person
 * acting is the one whose login it is, which is the same rule
 * `actorSnapshot()` already applies on the staff side.
 *
 * ── One rebuild, and only when there is something to change ────────────────
 *
 * `ADD CONSTRAINT … CHECK` is `ALGORITHM=COPY` in MySQL 8 and blocks DML while
 * it runs, so three of them would rebuild this table three times — and a
 * re-run would pay for all three to change nothing. Migration 217 solved the
 * same problem the same way and this follows it: the stored `CHECK_CLAUSE` is
 * read first, a constraint that already admits the value is left alone, and
 * every `ADD` that is still needed goes into **one** `ALTER` with the new
 * column riding along, since the table is being copied anyway. The `DROP
 * CHECK`s are metadata-only, so they stay in a statement of their own rather
 * than relying on MySQL's ordering of a same-name drop-and-add inside one
 * `ALTER`.
 *
 * Every statement is **recoverable on a re-run**: MySQL commits DDL
 * implicitly, so a crash between two of them must leave a state the guards
 * recompute from (migrations 134/140/155/183/205/206/212/217/218). A crash
 * after the drops and before the adds leaves the CHECKs missing, and the next
 * run re-adds exactly them.
 *
 * ── `down()` is lossy in a way `up()` cannot repair ────────────────────────
 *
 * Dropping `end_date` destroys every stamp taken since deploy, and re-running
 * `up()` re-adds an empty column — so every Past Goal silently reads `—` again,
 * which is the one fact this migration exists to record. It is migration 218's
 * situation word for word, and there is nothing else a `down` of a
 * server-stamped column could do; it is written here so the next reader does
 * not mistake this one for reversible. Rolling back while
 * `/me/personal-goals` is serving traffic is worse still: every member write
 * then fails the narrowed CHECK, so the order is migrate-then-deploy and the
 * reverse is not safe (`docs/go-to-production.md`).
 */

const TABLE = 'member_personal_goals';
/** Mirrors migration 212's `PREFIX`. */
const PREFIX = 'mpgoal';

/** Mirrors `ASSIGNMENT_ACTOR_TYPES` in `api/src/domain/personalGoalAssignment.ts`. */
const ACTOR_TYPES = ['staff', 'superadmin', 'member'];

const ACTOR_COLUMNS = ['created_by_type', 'modified_by_type', 'deleted_by_type'];

/**
 * A CHECK constraint's name is schema-global in MySQL 8, not table-scoped,
 * which is why migration 212 prefixed every one of them (and why migration 218
 * scopes its own guard the same way). `CONSTRAINT_TYPE` is named because that
 * view also holds PRIMARY/UNIQUE/FOREIGN KEY rows, and a `DROP CHECK` aimed at
 * one of those would die with ER_CHECK_CONSTRAINT_NOT_FOUND.
 */
async function hasCheck(knex, name) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?
       AND CONSTRAINT_TYPE = 'CHECK'`,
    [name],
  );
  return Number(rows[0].cnt) > 0;
}

/**
 * Migration 217's device: does the stored clause already admit this value?
 *
 * The quotes are part of the pattern — MySQL stores the clause with its
 * literals quoted (`… in (_utf8mb4'staff',_utf8mb4'superadmin')`), so matching
 * `'member'` rather than `member` cannot be satisfied by a column or table
 * name that merely contains the word.
 */
async function checkAllows(knex, name, value) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ?
       AND CHECK_CLAUSE LIKE ?`,
    [name, `%'${value}'%`],
  );
  return Number(rows[0].cnt) > 0;
}

function actorCheckSql(column, values) {
  const list = values.map((v) => `'${v}'`).join(', ');
  return `CHECK (${column} IS NULL OR ${column} IN (${list}))`;
}

/**
 * Plans the one ALTER: which CHECKs are stale, and therefore which to drop and
 * which to add. A constraint that already says what this direction wants is
 * left untouched, so a re-run rebuilds nothing.
 *
 * `'member'` is the only value that moves in either direction, so whether the
 * stored clause mentions it is the whole test: `up()` wants it present,
 * `down()` wants it gone.
 */
async function planActorChecks(knex, values) {
  const shouldAdmitMember = values.includes('member');
  const drops = [];
  const adds = [];
  for (const column of ACTOR_COLUMNS) {
    const name = `chk_${PREFIX}_${column}`;
    const exists = await hasCheck(knex, name);
    if (exists && (await checkAllows(knex, name, 'member')) === shouldAdmitMember) continue;
    if (exists) drops.push(`DROP CHECK ${name}`);
    adds.push(`ADD CONSTRAINT ${name} ${actorCheckSql(column, values)}`);
  }
  return { drops, adds };
}

exports.up = async (knex) => {
  const { drops, adds } = await planActorChecks(knex, ACTOR_TYPES);
  if (drops.length) await knex.raw(`ALTER TABLE ${TABLE} ${drops.join(', ')}`);

  // The column rides along in the same ALTER when there is one: appended with
  // no `AFTER`, which is INSTANT on its own (migration 218's note) and free
  // when the table is being copied for the CHECKs anyway.
  if (!(await knex.schema.hasColumn(TABLE, 'end_date'))) {
    adds.unshift('ADD COLUMN end_date DATE NULL');
  }
  if (adds.length) await knex.raw(`ALTER TABLE ${TABLE} ${adds.join(', ')}`);
};

exports.down = async (knex) => {
  // Narrowing the CHECKs back would be refused by any row a member wrote, so
  // those rows' actor *type* is cleared first — `staff` would be a lie about a
  // member. The `*_by_name` beside it is deliberately kept: no constraint
  // names it, and a name with a NULL type is already a legitimate row
  // (migration 215's backfill writes exactly that shape).
  for (const column of ACTOR_COLUMNS) {
    await knex.raw(`UPDATE ${TABLE} SET ${column} = NULL WHERE ${column} = 'member'`);
  }
  const narrowed = ['staff', 'superadmin'];
  const { drops, adds } = await planActorChecks(knex, narrowed);
  if (drops.length) await knex.raw(`ALTER TABLE ${TABLE} ${drops.join(', ')}`);

  // See the header: this destroys every stamp taken since deploy, and a later
  // `up()` re-adds an empty column rather than recovering them.
  if (await knex.schema.hasColumn(TABLE, 'end_date')) {
    adds.push('DROP COLUMN end_date');
  }
  if (adds.length) await knex.raw(`ALTER TABLE ${TABLE} ${adds.join(', ')}`);
};

exports.ACTOR_TYPES = ACTOR_TYPES;
