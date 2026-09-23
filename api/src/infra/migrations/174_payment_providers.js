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
 * The table has no `gym_id` — like `themes`, `charge_types` and
 * `professional_services` it is platform-level catalogue data administered
 * outside any one gym (CLAUDE.md's `gym_id` rule covers *domain* tables). The
 * tenant-scoped end of the relation is `gyms.payment_provider_id`.
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

  // ─── 2. Seed the provider every gym is already transacting through ─────────
  await knex.raw(
    `INSERT INTO ${TABLE} (name, provider_key, description, is_default, status, created_at)
     SELECT ?, ?, ?, 1, 'active', UTC_TIMESTAMP() FROM DUAL
     WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} p WHERE p.deleted_at IS NULL)`,
    [
      SEED_PROVIDER_NAME,
      SEED_PROVIDER_KEY,
      'Seeded by migration 174 (#636). Credentials come from the API environment (MONEI_API_KEY / MONEI_WEBHOOK_SECRET).',
    ],
  );

  // ─── 3. The gym's mandatory provider ──────────────────────────────────────
  if (!(await knex.schema.hasColumn('gyms', 'payment_provider_id'))) {
    await knex.raw('ALTER TABLE gyms ADD COLUMN payment_provider_id INT UNSIGNED NULL AFTER theme_id');
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

  await knex.raw('ALTER TABLE gyms MODIFY COLUMN payment_provider_id INT UNSIGNED NOT NULL');

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
