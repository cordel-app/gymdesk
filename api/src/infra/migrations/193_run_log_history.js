/**
 * #780: the nightly run logs become histories.
 *
 * `billing_run_log` (migration 111) and `recurring_booking_run_log`
 * (migration 170) are single-row tables holding one `last_run_at`, stamped
 * when a run *starts* and read as a 23-hour rate limit. The ticket replaces
 * that rule with "at most one **completed** run per UTC date", which the old
 * shape cannot express: one timestamp cannot say whether the run it belongs to
 * finished, and a stamp written at the start is indistinguishable from a run
 * that crashed a second later and locked the day.
 *
 * So both tables grow into what the ticket asks for — "a history table (one
 * row per run) is preferred: it is what the freshness alert and the dashboard
 * read, and it costs nothing":
 *
 *   id          INT UNSIGNED AUTO_INCREMENT (was TINYINT UNSIGNED, CHECK id = 1)
 *   run_date    DATE      — the UTC calendar date the guard counts
 *   status      VARCHAR(20) — in_progress | completed | failed
 *   started_at  DATETIME
 *   finished_at DATETIME NULL — NULL while in progress
 *   <counters>  INT UNSIGNED NOT NULL DEFAULT 0
 *
 * `status` is bounded by `chk_<table>_status`, so a new run status goes in two
 * places: `RunLogStatus` in `api/src/domain/runGuard.ts` and that CHECK.
 *
 * The counters differ per table because the two runs count different things:
 * the billing run reports `processed/succeeded/failed/waived`, the recurring
 * booking run `processed/created/skipped/failed/notified` — the same fields
 * each endpoint already returns and `.github/workflows/*-run.yml` already
 * parses (#778). Naming them as columns rather than dropping a JSON blob in
 * keeps the freshness alert's future query ordinary SQL.
 *
 * Two things worth knowing when reading a row back. `failed` is both a
 * `status` value and a counter column, and they mean different things:
 * `WHERE status = 'failed'` is a run that threw, `WHERE failed > 0` a run that
 * completed but could not charge (or book) everything. And the carried-over
 * singleton below becomes a `completed` row with every counter at its
 * `DEFAULT 0` — correct, since the old shape stored no counts, but it will
 * read on a dashboard as one historical run that did nothing.
 *
 * **Migration 111's `gym_id` exception carries over unchanged.** Neither table
 * has one: a nightly run is a system-wide job, not tenant data. It is the same
 * exception, not a new one.
 *
 * ## The existing row
 *
 * Each table holds exactly one seeded row (`id = 1`). Where its `last_run_at`
 * is set it becomes a `completed` run on that timestamp's UTC date — the old
 * column only ever meant "a run started, and we have no record of it failing",
 * and reading it as completed is the conservative choice: it keeps today's
 * guard closed for a run that happened minutes before this migration. Where it
 * is NULL the row is a placeholder for a run that never happened and is
 * deleted, so an empty history means exactly that.
 *
 * ## No unique index on "one completed run per date"
 *
 * The invariant lives in `claimRun()`'s `SELECT … FOR UPDATE`, not in a unique
 * index over a `completed`-only generated column. That index was considered
 * and declined: `finishRun()` writes `completed` *after* the night's charges
 * have been made, so a lost race would turn into a duplicate-key error at the
 * end of a run that had already charged real cards — a 500 in place of two
 * history rows, which is worse than the thing it prevents. What actually stops
 * a second run from re-charging anybody is unchanged and is not in this table:
 * a membership the first run advanced has `next_billing_date` in the future
 * and is not selected again.
 *
 * ## Cost
 *
 * Both tables hold one row. Every statement here is trivially fast, including
 * the `MODIFY id` rebuild and the `ADD CONSTRAINT`/`DROP CHECK` pair that
 * would be expensive on a real table (see migration 170's header). No
 * maintenance window is needed.
 *
 * ## Ordering and re-runnability
 *
 * DDL commits implicitly, so a run that dies between two statements must come
 * back and finish the rest — every step is therefore guarded by its own
 * information_schema check rather than nested inside one `hasColumn` branch
 * (migrations 168, 169 and 170 for precedent). The `id` column is switched to
 * AUTO_INCREMENT only after `chk_*_run_log_id` is gone: MySQL refuses an
 * auto-increment column whose CHECK pins it to 1.
 *
 * `down()` collapses the history back to the singleton, keeping the most
 * recent completed run as `last_run_at`. It is lossy — the counters and the
 * per-run history are dropped — but nothing reads them except this feature,
 * and the guard that comes back is the 23-hour one.
 */

/** Counter columns per log, matching what each endpoint reports. */
const RUN_LOGS = {
  billing_run_log: {
    idCheck: 'chk_billing_run_log_id',
    counters: ['processed', 'succeeded', 'failed', 'waived'],
  },
  recurring_booking_run_log: {
    idCheck: 'chk_recurring_booking_run_log_id',
    counters: ['processed', 'created', 'skipped', 'failed', 'notified'],
  },
};

async function constraintExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

async function indexExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, name],
  );
  return row.cnt > 0;
}

/** Is a column still nullable? Keeps the tightening ALTERs from re-running. */
async function columnIsNullable(knex, table, column) {
  const [[row]] = await knex.raw(
    `SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return Boolean(row) && row.nullable === 'YES';
}

/** Is `id` already AUTO_INCREMENT? Tells a finished conversion from a partial one. */
async function idIsAutoIncrement(knex, table) {
  const [[row]] = await knex.raw(
    `SELECT EXTRA AS extra FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'id'`,
    [table],
  );
  return Boolean(row) && String(row.extra).includes('auto_increment');
}

exports.up = async (knex) => {
  for (const [table, { idCheck, counters }] of Object.entries(RUN_LOGS)) {
    // Migrations 111 and 170 create these unconditionally, so a missing table
    // means the chain was not applied in order. Skipping it would record 193
    // as applied and leave `claimRun()` failing at runtime against a schema
    // that looks migrated, so fail here instead.
    if (!(await knex.schema.hasTable(table))) {
      throw new Error(`193: ${table} is missing — run migrations 111 and 170 first`);
    }

    // 1. The new columns. `run_date`/`started_at` land nullable so the
    //    backfill below has somewhere to write before they are tightened.
    if (!(await knex.schema.hasColumn(table, 'run_date'))) {
      await knex.schema.alterTable(table, (t) => t.date('run_date').nullable());
    }
    if (!(await knex.schema.hasColumn(table, 'status'))) {
      await knex.schema.alterTable(table, (t) =>
        t.string('status', 20).notNullable().defaultTo('in_progress'),
      );
    }
    if (!(await knex.schema.hasColumn(table, 'started_at'))) {
      await knex.schema.alterTable(table, (t) => t.dateTime('started_at').nullable());
    }
    if (!(await knex.schema.hasColumn(table, 'finished_at'))) {
      await knex.schema.alterTable(table, (t) => t.dateTime('finished_at').nullable());
    }
    for (const counter of counters) {
      if (!(await knex.schema.hasColumn(table, counter))) {
        await knex.schema.alterTable(table, (t) =>
          t.specificType(counter, 'INT UNSIGNED').notNullable().defaultTo(0),
        );
      }
    }

    // 2. Carry the singleton over, then drop the placeholder. Guarded on
    //    `last_run_at` still existing so a re-run after step 4 is a no-op.
    if (await knex.schema.hasColumn(table, 'last_run_at')) {
      await knex.raw(
        `UPDATE ${table}
            SET run_date    = DATE(last_run_at),
                started_at  = last_run_at,
                finished_at = last_run_at,
                status      = 'completed'
          WHERE last_run_at IS NOT NULL AND run_date IS NULL`,
      );
      // Narrowed the same way the UPDATE above is. Every row `claimRun()`
      // writes leaves `last_run_at` NULL — the new code never touches that
      // column — so a bare `WHERE last_run_at IS NULL` would delete the whole
      // history, not the one seeded placeholder, on any re-entry that still
      // finds the column. The window is real: step 4 is three separately
      // committed statements, and a crash between the `MODIFY id` and the
      // `dropColumn` leaves a table that is already a working history *and*
      // still carries `last_run_at`. Since step 3 makes `run_date` NOT NULL,
      // this is a provable no-op on every re-entry.
      await knex.raw(`DELETE FROM ${table} WHERE last_run_at IS NULL AND run_date IS NULL`);
    }

    // 3. Tighten the two columns every row now has. Done before the
    //    AUTO_INCREMENT switch so a partially applied migration cannot leave a
    //    history table accepting rows with no date.
    if (await columnIsNullable(knex, table, 'run_date')) {
      await knex.raw(`ALTER TABLE ${table} MODIFY run_date DATE NOT NULL`);
    }
    if (await columnIsNullable(knex, table, 'started_at')) {
      await knex.raw(`ALTER TABLE ${table} MODIFY started_at DATETIME NOT NULL`);
    }

    // 4. One row per run: the id stops being a pinned 1 and starts counting.
    //    The CHECK has to go first — MySQL rejects an AUTO_INCREMENT column
    //    constrained to a single value.
    if (await constraintExists(knex, table, idCheck)) {
      await knex.raw(`ALTER TABLE ${table} DROP CHECK ${idCheck}`);
    }
    if (!(await idIsAutoIncrement(knex, table))) {
      await knex.raw(`ALTER TABLE ${table} MODIFY id INT UNSIGNED NOT NULL AUTO_INCREMENT`);
    }
    if (await knex.schema.hasColumn(table, 'last_run_at')) {
      await knex.schema.alterTable(table, (t) => t.dropColumn('last_run_at'));
    }

    // 5. The guard's own read: "anything in progress, or on the last two
    //    dates". One composite index answers both halves of it.
    const idxDate = `idx_${table}_run_date_status`;
    if (!(await indexExists(knex, table, idxDate))) {
      await knex.raw(`CREATE INDEX ${idxDate} ON ${table} (run_date, status)`);
    }
    const idxStatus = `idx_${table}_status_started_at`;
    if (!(await indexExists(knex, table, idxStatus))) {
      await knex.raw(`CREATE INDEX ${idxStatus} ON ${table} (status, started_at)`);
    }

    // 6. The status vocabulary, bounded the way every other enum-ish column in
    //    this schema is. `ADD CONSTRAINT … CHECK` is the statement migrations
    //    174/189 refused on `user_memberships` because it rebuilds the table
    //    under ALGORITHM=COPY; here the table holds one row per night, so the
    //    rebuild is free and the guarantee is worth having.
    const statusCheck = `chk_${table}_status`;
    if (!(await constraintExists(knex, table, statusCheck))) {
      await knex.raw(
        `ALTER TABLE ${table} ADD CONSTRAINT ${statusCheck} ` +
        `CHECK (status IN ('in_progress','completed','failed'))`,
      );
    }
  }
};

exports.down = async (knex) => {
  for (const [table, { idCheck, counters }] of Object.entries(RUN_LOGS)) {
    if (!(await knex.schema.hasTable(table))) continue;

    if (!(await knex.schema.hasColumn(table, 'last_run_at'))) {
      await knex.schema.alterTable(table, (t) => t.dateTime('last_run_at').nullable());
    }

    const statusCheck = `chk_${table}_status`;
    if (await constraintExists(knex, table, statusCheck)) {
      await knex.raw(`ALTER TABLE ${table} DROP CHECK ${statusCheck}`);
    }

    // Carry the value over *first*, into the column that survives.
    //
    // `status` and `started_at` are dropped further down and DDL commits
    // implicitly, so reading them unguarded here would make a second attempt at
    // a half-finished rollback fail with ER_BAD_FIELD_ERROR (1054) — and lose
    // the timestamp with it. Parking it in `last_run_at` makes every later step
    // re-runnable.
    //
    // It never passes through JS: `MAX(started_at)` comes back as a `Date` or a
    // string depending on the connection's `timezone`/`dateStrings`, and
    // round-tripping it through mysql2 can shift the restored stamp — and with
    // it the restored 23-hour window — by the connection's UTC offset. Every
    // row gets the same value, so whichever one survives below carries it.
    if (
      (await knex.schema.hasColumn(table, 'status')) &&
      (await knex.schema.hasColumn(table, 'started_at'))
    ) {
      await knex.raw(
        `UPDATE ${table} SET last_run_at = (
           SELECT * FROM (SELECT MAX(started_at) FROM ${table} WHERE status = 'completed') AS latest
         )`,
      );
    }

    // Collapse to the singleton: keep one row and renumber it to 1. Both must
    // happen before `chk_<table>_id CHECK (id = 1)` goes back on, or the
    // ADD CONSTRAINT fails validating a surviving row whose id is not 1.
    await knex.raw(
      `DELETE FROM ${table}
        WHERE id <> (SELECT * FROM (SELECT MIN(id) FROM ${table}) AS keeper)`,
    );
    await knex.raw(`UPDATE ${table} SET id = 1`);

    for (const idx of [`idx_${table}_run_date_status`, `idx_${table}_status_started_at`]) {
      if (await indexExists(knex, table, idx)) {
        await knex.raw(`DROP INDEX ${idx} ON ${table}`);
      }
    }

    // AUTO_INCREMENT off before the CHECK goes back on, mirroring `up()`:
    // MySQL forbids an auto-increment column inside a CHECK expression.
    if (await idIsAutoIncrement(knex, table)) {
      await knex.raw(`ALTER TABLE ${table} MODIFY id TINYINT UNSIGNED NOT NULL DEFAULT 1`);
    }
    if (!(await constraintExists(knex, table, idCheck))) {
      await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${idCheck} CHECK (id = 1)`);
    }

    for (const column of ['finished_at', 'started_at', 'status', 'run_date', ...counters]) {
      if (await knex.schema.hasColumn(table, column)) {
        await knex.schema.alterTable(table, (t) => t.dropColumn(column));
      }
    }

    // An empty history restores the NULL placeholder migrations 111/170 seeded.
    await knex.raw(`INSERT IGNORE INTO ${table} (id, last_run_at) VALUES (1, NULL)`);
  }
};
