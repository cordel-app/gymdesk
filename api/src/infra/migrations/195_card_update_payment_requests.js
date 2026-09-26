/**
 * #788: a member replaces their stored card without being charged.
 *
 * The card-update flow reuses the hosted payment page, so it needs a
 * `payment_requests` row to hang a `page_token` and a `provider_order` off —
 * the page loads by token and the webhook reconciles by provider order, and
 * neither has another table to look in. What it must NOT be is a charge:
 *
 * 1. `chk_payment_requests_source` gains `card_update`. That value is what
 *    every financial surface excludes (the Members list's `payment_status`,
 *    the staff and member request lists) and what the webhook branches on to
 *    store the new token *without* writing a `payment_recorded` Billing Event,
 *    stamping `next_billing_date` or clearing the dunning counters. It is the
 *    fourth widening of this CHECK — see 111 (`billing_run`) and 165
 *    (`retry`, `manual`).
 *
 * 2. `charge_type_id` becomes nullable. A zero-amount card verification bills
 *    nothing, so there is no charge type that honestly describes it; the
 *    alternative — a `card_verification` row in the `charge_types` catalogue —
 *    would show up in the cash-payment picker and in charge-type reporting as
 *    if money could move through it. Written as raw `MODIFY` rather than
 *    knex's `.alter()` so the column's FK and its index are untouched.
 *    Nothing reads the column without a NULL check: the webhook only uses it
 *    on the branch that writes a Billing Event, which a card update never
 *    takes, and no query joins `charge_types` off `payment_requests` at all.
 *    Dropping the NOT NULL also removes the only thing that made a *missing*
 *    global `membership_fee` charge type fail loudly in the nightly run, so
 *    `POST /billing/run` now checks for it explicitly before charging anyone.
 *
 * 3. `payment_methods.updated_at` — the upsert that stores a token has always
 *    left `created_at` at the first payment's timestamp, so with replacement
 *    the row could no longer say when the card on file was stored. Both the
 *    member's "Payment method" section and the staff read show
 *    `COALESCE(updated_at, created_at)`. That expression compares the two
 *    columns, so `created_at`'s migration-103 default (`CURRENT_TIMESTAMP`,
 *    i.e. `NOW()`, evaluated against the server's `@@session.time_zone`) is
 *    normalised to `UTC_TIMESTAMP()` here: the app writes `updated_at` in UTC,
 *    and on a host whose clock is not UTC the pair would otherwise be on two
 *    time bases — skewing what the member is told and inverting the ordering.
 *    `docs/architecture.md` states the convention (`UTC_TIMESTAMP()`, never
 *    `NOW()`); this is the column that predates it.
 *
 * Cost: `ADD CONSTRAINT … CHECK` is `ALGORITHM=COPY` (MySQL refuses INPLACE
 * for it) and the `MODIFY` is a second rebuild, so this copies
 * `payment_requests` twice under a metadata lock — the same cost 111 and 165
 * paid, and the reason CLAUDE.md declines CHECKs on `user_memberships`. Each
 * statement is guarded, so a re-run after a partial failure copies nothing.
 */

/** MySQL: ER_CHECK_CONSTRAINT_NOT_FOUND — the only error a DROP CHECK may swallow. */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const SOURCE_CHECK = 'chk_payment_requests_source';

const dropCheckIfExists = (knex, sql) =>
  knex.raw(sql).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });

/**
 * Whether the source CHECK already allows `value`. Matched inside the clause
 * rather than by equality because MySQL stores it with a charset prefix per
 * literal, which differs by the database's own collation
 * (`_utf8mb4\'card_update\'` here) — and it stores the quotes **escaped**, so
 * the backslashes come off before matching or every lookup answers "no" and
 * every run rebuilds the table.
 */
const sourceCheckAllows = async (knex, value) => {
  const rows = await knex.raw(
    `SELECT cc.CHECK_CLAUSE
       FROM information_schema.CHECK_CONSTRAINTS cc
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA
        AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = 'payment_requests'
        AND cc.CONSTRAINT_NAME = ?`,
    [SOURCE_CHECK],
  );
  const clause = (rows[0][0]?.CHECK_CLAUSE ?? '').replace(/\\/g, '');
  return clause.includes(`'${value}'`);
};

const setSourceCheck = async (knex, values) => {
  await dropCheckIfExists(knex, `ALTER TABLE payment_requests DROP CHECK ${SOURCE_CHECK}`);
  await knex.raw(
    `ALTER TABLE payment_requests ADD CONSTRAINT ${SOURCE_CHECK} ` +
    `CHECK (source IN (${values.map((v) => `'${v}'`).join(',')}))`,
  );
};

const chargeTypeIsNullable = async (knex) => {
  const rows = await knex.raw(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_requests'
        AND COLUMN_NAME = 'charge_type_id'`,
  );
  return rows[0][0]?.IS_NULLABLE === 'YES';
};

const countRows = async (knex, sql) => {
  const rows = await knex.raw(sql);
  return Number(rows[0][0].n);
};

exports.up = async (knex) => {
  // Guarded like every other statement here: an unguarded swap would drop a
  // CHECK that is already correct and re-add it — reopening the window in which
  // the column has no constraint (DDL is not transactional), and paying for a
  // second full copy of the table.
  if (!(await sourceCheckAllows(knex, 'card_update'))) {
    await setSourceCheck(knex, ['admin', 'customer', 'billing_run', 'retry', 'manual', 'card_update']);
  }

  if (!(await chargeTypeIsNullable(knex))) {
    await knex.raw('ALTER TABLE payment_requests MODIFY COLUMN `charge_type_id` INT UNSIGNED NULL');
  }

  if (!(await knex.schema.hasColumn('payment_methods', 'updated_at'))) {
    await knex.schema.alterTable('payment_methods', (t) => {
      t.dateTime('updated_at').nullable();
    });
  }

  const created = await knex.raw(
    `SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_methods'
        AND COLUMN_NAME = 'created_at'`,
  );
  if (created[0][0]?.COLUMN_DEFAULT === 'CURRENT_TIMESTAMP') {
    await knex.raw(
      'ALTER TABLE payment_methods MODIFY COLUMN `created_at` DATETIME DEFAULT (UTC_TIMESTAMP())',
    );
  }
};

exports.down = async (knex) => {
  // All or nothing, decided before anything is touched. Restoring NOT NULL is
  // only possible while the column holds no NULL — and a card verification has
  // no charge type to fill in, so a `card_update` row cannot be rolled back
  // either. Dropping `payment_methods.updated_at` on its own (it is always
  // droppable) would leave a schema that is neither 194 nor 195: still
  // accepting `card_update` rows, while `loadStoredCard()` selects a column
  // that is gone. Migration 165 drops its columns last for the same reason.
  const blockers = await countRows(
    knex,
    "SELECT (SELECT COUNT(*) FROM payment_requests WHERE source = 'card_update')"
    + ' + (SELECT COUNT(*) FROM payment_requests WHERE charge_type_id IS NULL) AS n',
  );
  if (blockers > 0) return;

  if (await chargeTypeIsNullable(knex)) {
    await knex.raw('ALTER TABLE payment_requests MODIFY COLUMN `charge_type_id` INT UNSIGNED NOT NULL');
  }

  // Runs only after the MODIFY above succeeded, so the window in which the
  // column has no CHECK at all is never opened by a failure: the narrow set is
  // the current set minus `card_update`, which the count above proved no row
  // uses, so the re-ADD cannot fail on data either.
  if (await sourceCheckAllows(knex, 'card_update')) {
    await setSourceCheck(knex, ['admin', 'customer', 'billing_run', 'retry', 'manual']);
  }

  if (await knex.schema.hasColumn('payment_methods', 'updated_at')) {
    await knex.schema.alterTable('payment_methods', (t) => t.dropColumn('updated_at'));
  }

  // `created_at`'s default is deliberately left as `UTC_TIMESTAMP()`: it is
  // what `docs/architecture.md` asks for, migration 103's `CURRENT_TIMESTAMP`
  // was the anomaly, and putting a local-time default back would corrupt the
  // column for rows written after the rollback.
};
