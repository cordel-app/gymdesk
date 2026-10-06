/**
 * #1121 stage 2 — **a Product a member bought**: `member_products`, plus the
 * two widenings `payment_requests` needs to carry a purchase that is not a
 * membership fee.
 *
 * Stage 1 added no schema at all, because the catalogue is a read of `products`
 * (§7: no second catalogue). A *purchase* is the opposite: the thread's `Q2`
 * asks for "a new structure/new table: `member_products`. System should store
 * there a snapshot of what has been purchased while maintaining a link against
 * the original product", and neither existing table can hold one —
 * `user_membership_services` (migration 164) is a periodic service *window*
 * hung off an Assigned Plan, with no status and no row for a member who holds
 * no plan (#956 allows zero), and `user_class_packages` holds session balances
 * rather than what was bought.
 *
 * ── The snapshot, and why it is beside the link rather than instead of it ───
 *
 * `product_id` is the link `Q2` asks for; `product_name`, `product_type`,
 * `billing_frequency`, `units`, `amount`, `currency` and `tax_rate_percent` are
 * what the member was shown and charged. That pair is #635 §16's rule one table
 * over: a Product renamed, repriced, retired or re-rated after the purchase
 * must not move what a past purchase says it was, and the live row is where
 * "what is this Product now" is answered. `amount` is the **VAT-inclusive**
 * figure, because that is the one number the member is quoted (#1121 §3 and
 * #817: the gross-up is the server's), with `tax_rate_percent` recording the
 * rate behind it — `NULL` where the gym has configured none, which is a
 * different fact from 0%.
 *
 * ── Three statuses, and the one the UNIQUE key is about ────────────────────
 *
 * §6 asks for three states: available, purchased/active and pending payment.
 * "Available" is the absence of a row, so the column holds the other two plus
 * `cancelled`, which is where a purchase whose payment failed or expired goes —
 * without it a failed attempt would sit `pending_payment` for ever and block
 * the retry §6's own "do not allow duplicate purchases" asks for.
 *
 * `mprod_pending_purchase_key` (migration 183's generated-column device) is
 * UNIQUE over `(member_id, product_id)` **while the row is `pending_payment`**,
 * so a double-tapped Buy, a second browser tab and a webhook retry cannot
 * produce two checkouts for one item — and the route's own 409 and the index
 * agree by construction. It deliberately does **not** cover `active`: nothing
 * in `products` says a Product may be bought once (the thread's `Q1` answer is
 * explicit that the member catalogue is the gym's two existing columns and no
 * new flag), and a second 10-session package months later is a real purchase,
 * so refusing it would be this migration inventing a rule the product model
 * does not have. `UNIQUE (payment_request_id)` is the other half of the same
 * idea: one purchase per payment, so the webhook completing twice completes one
 * row.
 *
 * ── `payment_requests` ─────────────────────────────────────────────────────
 *
 * 1. `chk_payment_requests_source` gains **`product_purchase`** — the fifth
 *    widening of this CHECK (111, 165, 195). A purchase *is* money, unlike
 *    #788's `card_update`, so financial surfaces keep showing it; what the new
 *    value is for is the surfaces that mean the **membership fee** specifically:
 *    the Members list's `payment_status` (where a pending purchase would read as
 *    an unpaid fee, exactly the defect 195's header describes) and the member's
 *    own "you have a payment to finish" prompt.
 *
 * 2. `user_membership_id` becomes **nullable**. A purchase belongs to the
 *    member, not to an assignment, and under #956 a member may hold no plan at
 *    all — hanging the row off "their most recent assignment" the way
 *    `resolveCardUpdateMembership()` does would make the shop answer 400 for
 *    exactly the members most likely to use it. Every reader was audited for
 *    the NULL: `payment-page.ts` LEFT JOINs it (an INNER JOIN answered "token
 *    not found" for a purchase), the webhook already guards
 *    `stampFirstNextBillingDate()` on it, and the staff and member request
 *    lists LEFT JOIN `user_memberships` already.
 *
 * Cost: `ADD CONSTRAINT … CHECK` is `ALGORITHM=COPY` — it rebuilds the table
 * and **blocks concurrent DML**, which is the statement to plan a deploy
 * around, the same price 111, 165 and 195 paid. The `MODIFY` to NULLable is
 * `ALGORITHM=INPLACE`: it rebuilds too, but permits writes. Both are guarded,
 * so a re-run after a partial failure touches nothing. MySQL commits DDL
 * implicitly, so every statement here stands on its own — and the table is one
 * `CREATE`, which is why the generated column and its UNIQUE index need no
 * repair block of the kind migration 212 carries (it adds both to a table that
 * may already exist).
 *
 * One interaction to remember rather than to guard here: `payment_request_id`
 * is `ON DELETE SET NULL`, and `cancelAbandonedPurchases()` reaches a stuck
 * `pending_payment` row *through* that column. A future retention sweep that
 * deletes settled `payment_requests` rows would therefore need a time-based
 * fallback (`payment_request_id IS NULL AND created_at < …`), or the UNIQUE key
 * below would refuse that member that Product for ever. Nothing deletes a
 * request today — `POST /billing/cleanup` expires them.
 */

const TABLE = 'member_products';

/**
 * The prefix every constraint and index on the table is named with. CHECK and
 * FK names are schema-global in MySQL 8 rather than table-scoped, which is why
 * migrations 212 and 224 prefix their own.
 */
const PREFIX = 'mprod';

/** Mirrors `MEMBER_PRODUCT_STATUSES` in `api/src/domain/memberProductPurchase.ts`. */
const STATUSES = ['pending_payment', 'active', 'cancelled'];

/** Mirrors `PURCHASE_ACTOR_TYPES` in the same module (#799's snapshot pair). */
const ACTOR_TYPES = ['staff', 'superadmin', 'member'];

/** Mirrors `PRODUCT_PURCHASE_SOURCE` in that module. */
const PURCHASE_SOURCE = 'product_purchase';

const SOURCE_CHECK = 'chk_payment_requests_source';

/** Every value the source CHECK permits once this migration has run. */
const SOURCES = ['admin', 'customer', 'billing_run', 'retry', 'manual', 'card_update', PURCHASE_SOURCE];

/** MySQL: ER_CHECK_CONSTRAINT_NOT_FOUND — the only error a DROP CHECK may swallow. */
const ER_CHECK_CONSTRAINT_NOT_FOUND = 3940;

const dropCheckIfExists = (knex, sql) =>
  knex.raw(sql).catch((err) => {
    if (err.errno !== ER_CHECK_CONSTRAINT_NOT_FOUND) throw err;
  });

/**
 * Whether the source CHECK already allows `value`. Matched inside the clause
 * rather than by equality, and with the backslashes stripped first, for
 * migration 195's reason: MySQL stores each literal with a charset prefix that
 * depends on the database's collation and stores the quotes escaped, so an
 * equality test answers "no" every time and every run rebuilds the table.
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
    `ALTER TABLE payment_requests ADD CONSTRAINT ${SOURCE_CHECK} `
    + `CHECK (source IN (${values.map((v) => `'${v}'`).join(',')}))`,
  );
};

const membershipIsNullable = async (knex) => {
  const rows = await knex.raw(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_requests'
        AND COLUMN_NAME = 'user_membership_id'`,
  );
  return rows[0][0]?.IS_NULLABLE === 'YES';
};

const countRows = async (knex, sql) => {
  const rows = await knex.raw(sql);
  return Number(rows[0][0].n);
};

exports.up = async (knex) => {
  const statuses = STATUSES.map((s) => `'${s}'`).join(', ');
  const actors = ACTOR_TYPES.map((t) => `'${t}'`).join(', ');

  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id                   INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        gym_id               CHAR(36)      NOT NULL,
        member_id            INT UNSIGNED  NOT NULL,
        product_id           INT UNSIGNED  NOT NULL,
        status               VARCHAR(20)   NOT NULL DEFAULT 'pending_payment',
        -- The snapshot: what the member was shown and charged, frozen.
        product_name         VARCHAR(255)  NOT NULL,
        product_type         VARCHAR(20)   NOT NULL,
        billing_frequency    VARCHAR(20)   NULL,
        units                INT UNSIGNED  NULL,
        amount               DECIMAL(10,2) NOT NULL,
        currency             CHAR(3)       NOT NULL DEFAULT 'EUR',
        tax_rate_percent     DECIMAL(5,2)  NULL,
        -- The payment that completes it. SET NULL rather than CASCADE: a
        -- purchase outlives the transaction that paid for it, and
        -- \`cleanupTestGyms\` (and a future retention sweep) deletes requests
        -- first.
        payment_request_id   INT UNSIGNED  NULL,
        billing_event_id     INT UNSIGNED  NULL,
        purchased_at         DATETIME      NULL,
        created_at           DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        -- No \`modified_by\` pair beside it, deliberately: every writer of this
        -- column is the payment webhook or the cleanup sweep, and neither is a
        -- person with a name to snapshot (#1051's own argument for leaving
        -- \`user_memberships\`' modified actor derived).
        modified_at          DATETIME      NULL,
        created_by_name      VARCHAR(255)  NULL,
        created_by_type      VARCHAR(20)   NULL,
        pending_purchase_key VARCHAR(64)   COLLATE utf8mb4_bin GENERATED ALWAYS AS (
                               IF(status = 'pending_payment',
                                  CONCAT(member_id, ':', product_id), NULL)
                             ) VIRTUAL,
        PRIMARY KEY (id),
        -- One checkout in flight per (member, Product), and one purchase per
        -- payment: both halves of §6's "do not allow the member to accidentally
        -- create duplicate purchases", enforced where the route cannot be
        -- raced.
        UNIQUE KEY ${PREFIX}_pending_purchase_key (pending_purchase_key),
        UNIQUE KEY ${PREFIX}_payment_request_key (payment_request_id),
        -- The member's own list, in the order their page reads it, and the
        -- gym-wide read the Admin side (#1118 §12) will add.
        KEY ${PREFIX}_member_index (gym_id, member_id, status),
        KEY ${PREFIX}_product_index (gym_id, product_id),
        -- \`cancelAbandonedPurchases()\` is the one read that narrows this table
        -- on \`status\` with no gym and no member (it runs system-wide from
        -- \`POST /billing/cleanup\`), and neither key above leads with it.
        -- \`${PREFIX}_pending_purchase_key\` cannot serve it either: MySQL matches a
        -- generated-column index only for a query that spells the generating
        -- expression, not a literal \`status = 'pending_payment'\`.
        KEY ${PREFIX}_status_index (status, payment_request_id),
        -- Declared rather than left to InnoDB, which would auto-create one named
        -- after each constraint: the composite keys above lead with \`gym_id\`, so
        -- these three FK columns back no index of their own (migration 212's
        -- convention).
        KEY ${PREFIX}_member_fk_index (member_id),
        KEY ${PREFIX}_product_fk_index (product_id),
        KEY ${PREFIX}_billing_event_fk_index (billing_event_id),
        CONSTRAINT ${PREFIX}_gym_fk FOREIGN KEY (gym_id)
          REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT ${PREFIX}_member_fk FOREIGN KEY (member_id)
          REFERENCES members(id) ON DELETE CASCADE,
        -- RESTRICT, deliberately: the purchase is the record of money that
        -- moved, so a Product may not be hard-deleted out from under it. The
        -- catalogue's own removal is a soft delete (\`products.deleted_at\`),
        -- which leaves every purchase exactly as it is — the same choice the
        -- Assigned Plan snapshot tables make (#635 stage 2).
        CONSTRAINT ${PREFIX}_product_fk FOREIGN KEY (product_id)
          REFERENCES products(id) ON DELETE RESTRICT,
        CONSTRAINT ${PREFIX}_payment_request_fk FOREIGN KEY (payment_request_id)
          REFERENCES payment_requests(id) ON DELETE SET NULL,
        CONSTRAINT ${PREFIX}_billing_event_fk FOREIGN KEY (billing_event_id)
          REFERENCES billing_events(id) ON DELETE SET NULL,
        CONSTRAINT chk_${PREFIX}_status CHECK (status IN (${statuses})),
        CONSTRAINT chk_${PREFIX}_amount CHECK (amount >= 0),
        CONSTRAINT chk_${PREFIX}_created_by_type
          CHECK (created_by_type IS NULL OR created_by_type IN (${actors}))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // Guarded for migration 195's reason: an unguarded swap would drop a CHECK
  // that is already correct and re-add it, reopening the window in which the
  // column has none (DDL is not transactional) and paying for a second copy of
  // the table.
  if (!(await sourceCheckAllows(knex, PURCHASE_SOURCE))) {
    await setSourceCheck(knex, SOURCES);
  }

  if (!(await membershipIsNullable(knex))) {
    await knex.raw('ALTER TABLE payment_requests MODIFY COLUMN `user_membership_id` INT UNSIGNED NULL');
  }
};

exports.down = async (knex) => {
  // All or nothing, decided before anything is touched — migration 195's shape.
  // Restoring NOT NULL is only possible while the column holds no NULL, and a
  // product purchase has no assignment to fill in, so a `product_purchase` row
  // cannot be rolled back either. The purchases themselves are counted too, and
  // not only the requests behind them: `payment_request_id` is `ON DELETE SET
  // NULL`, so a purchase outlives its request and a table still holding the
  // record of money that moved must not be dropped silently.
  const purchases = (await knex.schema.hasTable(TABLE))
    ? ` + (SELECT COUNT(*) FROM ${TABLE})`
    : '';
  const blockers = await countRows(
    knex,
    `SELECT (SELECT COUNT(*) FROM payment_requests WHERE source = '${PURCHASE_SOURCE}')`
    + ' + (SELECT COUNT(*) FROM payment_requests WHERE user_membership_id IS NULL)'
    + `${purchases} AS n`,
  );
  if (blockers > 0) return;

  if (await membershipIsNullable(knex)) {
    await knex.raw('ALTER TABLE payment_requests MODIFY COLUMN `user_membership_id` INT UNSIGNED NOT NULL');
  }

  // Runs only once the MODIFY above succeeded, so a failure never leaves the
  // column with no CHECK at all: the narrow set is the current set minus
  // `product_purchase`, which the count above proved no row uses.
  if (await sourceCheckAllows(knex, PURCHASE_SOURCE)) {
    await setSourceCheck(knex, SOURCES.filter((s) => s !== PURCHASE_SOURCE));
  }

  // Dropped **last**: it is the one statement here that cannot be re-run back
  // into place, and migrations 165 and 195 order their own irreversible step
  // the same way. Dropping it first would mean a failure in either reversion
  // above left the schema in the state the guard exists to prevent — neither
  // 227 nor 228.
  await knex.schema.dropTableIfExists(TABLE);
};

exports.TABLE = TABLE;
exports.PREFIX = PREFIX;
exports.STATUSES = STATUSES;
exports.ACTOR_TYPES = ACTOR_TYPES;
exports.PURCHASE_SOURCE = PURCHASE_SOURCE;
