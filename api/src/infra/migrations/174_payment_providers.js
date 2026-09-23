/**
 * #636: Payment Providers become a Cordel-level (platform-wide) catalogue, and
 * every gym points at exactly one of them.
 *
 * Before this, "Payment Providers" was not data at all: the admin page rendered
 * `PAYMENT_PROVIDER` / `MONEI_*` straight out of the container's environment,
 * and `api/src/payments/index.ts` resolved one provider process-wide. The
 * ticket keeps that global shape ("Payment Providers is a global
 * configuration") but asks for a real CRUD catalogue under Cordel plus a
 * mandatory per-gym field pre-populated with the default provider.
 *
 * What is NOT stored here: credentials. API keys and webhook secrets stay in
 * the environment (CLAUDE.md's "All config via environment variables"), so a
 * row names *which* adapter a gym transacts through — `provider_key` is the key
 * `getPaymentProvider()` switches on — and never how to authenticate as it.
 * That is also why there is no `environment` column: the sandbox/production
 * split is a property of the deployment's credentials, not of a catalogue row,
 * and `GET /platform/payment-providers/deployment` reports it from the API's
 * own env instead of duplicating it in MySQL where the two could disagree.
 *
 * The table has no `gym_id` at all — the same exception the global lookup
 * tables (`charge_types`, `benefit_types`, `action_types`, `result_types`) are,
 * with CRUD on top (CLAUDE.md's `gym_id` rule covers *domain* tables). Note it
 * is deliberately NOT the nullable-`gym_id` hybrid `themes` and
 * `nutrition_library_items` use: a gym can own a theme, but a payment provider
 * is never gym-owned — the ticket makes it global configuration, and the
 * tenant-scoped end of the relation is `gyms.payment_provider_id`.
 *
 * `provider_key` gets no CHECK constraint, unlike `status`: its permitted values
 * are `SUPPORTED_PAYMENT_PROVIDER_KEYS` in `api/src/payments/index.ts`, which
 * grows whenever an adapter is implemented, and a CHECK would mean a migration
 * per adapter for a column only superadmins can write and only the router ever
 * populates. (Contrast `member_notifications.type`, where the CHECK is a hard
 * constraint because an unlisted value there fails silently at insert time.)
 *
 * Two invariants are held by generated columns rather than by the API alone,
 * because both are read-then-write races on a superadmin-only endpoint:
 *   - `default_provider_key` — at most one non-deleted row may be the default.
 *     Setting a new default therefore has to clear the old one in the same
 *     transaction (see `setDefaultProvider()`).
 *   - `active_name_key` — names are unique among non-deleted rows only, so a
 *     retired provider's name can be reused.
 * Both are VIRTUAL: MySQL rejects STORED generated columns over FK columns and
 * VIRTUAL is enough for a secondary unique index (same reasoning as migrations
 * 007 and 164).
 *
 * `gyms.payment_provider_id` is NOT NULL with a plain (RESTRICT) foreign key:
 * "mandatory and cannot be null", and the FK is the backstop behind the API's
 * 409 for deleting a provider that gyms still use. Existing gyms are backfilled
 * to the seeded MONEI row — the provider they were already transacting through,
 * since it was the only one the code supported — so nothing changes for them.
 *
 * `financials.payment_providers` is dropped from `feature_flags`: the Finance
 * nav entry it gated is removed by this ticket, and the replacement lives in
 * the superadmin-only Cordel group, which is not flag-gated. A leftover row
 * would show up in Cordel → Feature Flags as a switch that moves nothing.
 *
 * Every ALTER/ADD CONSTRAINT is guarded through information_schema: MySQL DDL
 * is non-transactional, so a crash midway must not leave a re-run permanently
 * skipping a step (migrations 134/140/155 set the precedent).
 *
 * `down()` is lossy in two ways, both accepted rather than engineered around:
 * dropping `gyms.payment_provider_id` discards each gym's chosen provider, so a
 * rollback followed by a re-apply puts every gym back on the platform default
 * (nothing else could be reconstructed once the column is gone); and the
 * restored `financials.payment_providers` flag comes back enabled, even if it
 * had been switched off. Neither matters while `up()` has only ever assigned the
 * default, which is the state on every environment today — see
 * `docs/go-to-production.md` before rolling this back with real assignments.
 *
 * Migration number: 174 is also taken by the in-flight #635 stage 2 branch
 * (a different file name, so knex runs both in name order — the repo already
 * carries duplicate numbers from parallel agents, e.g. two 067s).
 */

const TABLE = 'payment_providers';

/** The only adapter `api/src/payments/index.ts` implements today. */
const SEED_PROVIDER_KEY = 'monei';
const SEED_PROVIDER_NAME = 'MONEI';

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

exports.up = async (knex) => {
  // ─── 1. The catalogue ──────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, (t) => {
      t.increments('id').unsigned().primary();
      t.string('name', 120).notNullable();
      /** Adapter key `getPaymentProvider()` switches on (e.g. 'monei'). */
      t.string('provider_key', 50).notNullable();
      t.string('description', 500).nullable();
      t.boolean('is_default').notNullable().defaultTo(false);
      t.string('status', 20).notNullable().defaultTo('active');
      t.datetime('created_at').notNullable().defaultTo(knex.raw('(UTC_TIMESTAMP())'));
      t.string('created_by_name', 255).nullable();
      t.datetime('modified_at').nullable();
      t.string('modified_by_name', 255).nullable();
      t.datetime('deleted_at').nullable();
      t.string('deleted_by_name', 255).nullable();

      t.index(['status'], 'payment_providers_status_index');
    });
  }

  if (!(await constraintExists(knex, TABLE, 'chk_payment_providers_status'))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD CONSTRAINT chk_payment_providers_status ` +
      "CHECK (status IN ('active','inactive'))",
    );
  }

  if (!(await knex.schema.hasColumn(TABLE, 'default_provider_key'))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD COLUMN default_provider_key TINYINT UNSIGNED ` +
      'GENERATED ALWAYS AS (IF(is_default = 1 AND deleted_at IS NULL, 1, NULL)) VIRTUAL',
    );
  }
  if (!(await indexExists(knex, TABLE, 'payment_providers_one_default'))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD UNIQUE KEY payment_providers_one_default (default_provider_key)`);
  }

  if (!(await knex.schema.hasColumn(TABLE, 'active_name_key'))) {
    await knex.raw(
      `ALTER TABLE ${TABLE} ADD COLUMN active_name_key VARCHAR(120) ` +
      'GENERATED ALWAYS AS (IF(deleted_at IS NULL, name, NULL)) VIRTUAL',
    );
  }
  if (!(await indexExists(knex, TABLE, 'payment_providers_unique_active_name'))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD UNIQUE KEY payment_providers_unique_active_name (active_name_key)`);
  }

  // ─── 2. Make sure a default exists ────────────────────────────────────────
  // The guard is on "is there a default", not "is the table empty": the
  // backfill below needs `is_default = 1`, so a table holding providers but no
  // default would otherwise send every re-run into the same dead end (it would
  // skip the seed, then fail the NOT NULL step, leaving `gyms` with a nullable
  // orphan column full of NULLs and nothing recorded in knex_migrations).
  const [[{ defaults }]] = await knex.raw(
    `SELECT COUNT(*) AS defaults FROM ${TABLE} WHERE is_default = 1 AND deleted_at IS NULL`,
  );
  if (Number(defaults) === 0) {
    // Promote an existing active row before inventing one — on a database that
    // already has providers, the operator's rows are better than a new MONEI.
    const [promoted] = await knex.raw(
      `UPDATE ${TABLE} SET is_default = 1
       WHERE deleted_at IS NULL AND status = 'active' ORDER BY id LIMIT 1`,
    );
    if (!promoted.affectedRows) {
      await knex.raw(
        `INSERT INTO ${TABLE} (name, provider_key, description, is_default, status, created_at)
         VALUES (?, ?, ?, 1, 'active', UTC_TIMESTAMP())`,
        [
          SEED_PROVIDER_NAME,
          SEED_PROVIDER_KEY,
          'Seeded by migration 174 (#636). Credentials come from the API environment (MONEI_API_KEY / MONEI_WEBHOOK_SECRET).',
        ],
      );
    }
  }

  const [[defaultRow]] = await knex.raw(
    `SELECT id FROM ${TABLE} WHERE is_default = 1 AND deleted_at IS NULL LIMIT 1`,
  );

  // ─── 3. The gym's mandatory provider ──────────────────────────────────────
  // The column is created WITH a temporary default: `db:migrate` runs before the
  // new build is live, so the old code's INSERT INTO gyms — which names no
  // provider — is still being served while this migration runs. Without the
  // default that insert writes a NULL and the MODIFY below then aborts
  // mid-migration; with it, a gym created in the window lands on the platform
  // default. The default is dropped again once the column is NOT NULL, so the
  // steady state is the one the API enforces: every insert names a provider.
  if (!(await knex.schema.hasColumn('gyms', 'payment_provider_id'))) {
    await knex.raw(
      `ALTER TABLE gyms ADD COLUMN payment_provider_id INT UNSIGNED NULL DEFAULT ${Number(defaultRow.id)} AFTER theme_id`,
    );
  }

  // Backfill every gym — soft-deleted ones included, so restoring one still
  // satisfies the NOT NULL below.
  await knex.raw(
    `UPDATE gyms SET payment_provider_id = (
       SELECT id FROM ${TABLE} WHERE is_default = 1 AND deleted_at IS NULL LIMIT 1
     ) WHERE payment_provider_id IS NULL`,
  );

  const [[{ orphans }]] = await knex.raw(
    'SELECT COUNT(*) AS orphans FROM gyms WHERE payment_provider_id IS NULL',
  );
  if (Number(orphans) > 0) {
    throw new Error(
      `Cannot make gyms.payment_provider_id NOT NULL: ${orphans} gym(s) still have none. ` +
      'A default payment provider must exist in payment_providers before this migration completes.',
    );
  }

  // Guarded: MODIFY rebuilds `gyms` (ALGORITHM=COPY on a table ~40 FKs point
  // at), so a re-run must not pay for it again.
  const [[providerColumn]] = await knex.raw(
    `SELECT IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gyms' AND COLUMN_NAME = 'payment_provider_id'`,
  );
  if (providerColumn.IS_NULLABLE === 'YES') {
    await knex.raw('ALTER TABLE gyms MODIFY COLUMN payment_provider_id INT UNSIGNED NOT NULL');
  }
  if (providerColumn.COLUMN_DEFAULT !== null) {
    await knex.raw('ALTER TABLE gyms ALTER COLUMN payment_provider_id DROP DEFAULT');
  }

  if (!(await constraintExists(knex, 'gyms', 'fk_gyms_payment_provider'))) {
    // No ON DELETE clause: RESTRICT is exactly what is wanted — a provider that
    // gyms point at cannot be hard-deleted out from under them.
    await knex.raw(
      `ALTER TABLE gyms ADD CONSTRAINT fk_gyms_payment_provider ` +
      `FOREIGN KEY (payment_provider_id) REFERENCES ${TABLE} (id)`,
    );
  }

  // ─── 4. Retire the Finance nav flag ───────────────────────────────────────
  await knex.raw("DELETE FROM feature_flags WHERE feature_key = 'financials.payment_providers'");
};

exports.down = async (knex) => {
  await knex.raw(
    `INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at)
     VALUES ('financials.payment_providers', 1, UTC_TIMESTAMP())`,
  );

  if (await constraintExists(knex, 'gyms', 'fk_gyms_payment_provider')) {
    await knex.raw('ALTER TABLE gyms DROP FOREIGN KEY fk_gyms_payment_provider');
  }
  if (await knex.schema.hasColumn('gyms', 'payment_provider_id')) {
    await knex.raw('ALTER TABLE gyms DROP COLUMN payment_provider_id');
  }
  await knex.schema.dropTableIfExists(TABLE);
};
