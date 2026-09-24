/**
 * #712: Show theme metadata in the Custom Themes header.
 *
 * `themes` has always carried `created_at`, but nothing recorded *who* created a
 * theme: the row has no `created_by_membership_id`, and a superadmin acting
 * directly has no `gym_memberships` row to join to anyway. Snapshot the actor's
 * display name and type at write time instead — the same immutable-snapshot
 * shape `themes.deleted_by_name` (migration 101) and `tax_rates.created_by_name`
 * (migration 126) already use — rather than adding an actor FK that would be
 * null for exactly the actors we most need to name.
 *
 * Backfill comes from `audit_logs`, which is where the creator of an existing
 * theme is already recorded (`gym-themes.ts` writes a `clone` entry with
 * `actor_name` for every customer theme): the earliest create/clone entry that
 * names an actor wins. Three deliberate limits:
 *
 *  - **Customer themes only** (`gym_id IS NOT NULL`). Base themes are created by
 *    `api/src/api/themes.ts`, which does not write these columns, so attributing
 *    the existing ones here would leave every base theme created *after* this
 *    deploy unattributed — a header that names a creator for old platform themes
 *    and not for new ones. `GET /platform/themes/:id` already resolves base-theme
 *    actor names from `audit_logs` directly and is unaffected.
 *  - **`created_by_type` stays null for backfilled rows.** The audit row snapshots
 *    the name but not whether the actor was staff or a superadmin; inventing one
 *    would be a guess. The CHECK below allows null for exactly this reason.
 *  - **`audit_logs.actor_name` carries an impersonation suffix** — `recordAudit()`
 *    writes `X (impersonating Y)` — where the live writer stores the bare name.
 *    Backfilled rows keep the suffix: it is what the audit trail says happened,
 *    and rewriting it here would be a second, lossy interpretation of the same
 *    event.
 *
 * `modified_at` is `ON UPDATE CURRENT_TIMESTAMP` (migration 056), so the backfill
 * assigns it to itself — an explicit assignment suppresses the auto-bump. Without
 * that, populating one field of the #712 header would silently rewrite another
 * ("Last modified") on every existing theme, irreversibly.
 *
 * Each DDL statement and the backfill are guarded independently so a retry after
 * a partial failure can resume instead of silently skipping what didn't finish.
 */

async function constraintExists(knex, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'themes'
       AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = ?`,
    [name],
  );
  return rows.length > 0;
}

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('themes', 'created_by_name'))) {
    await knex.schema.alterTable('themes', (t) => {
      t.string('created_by_name', 255).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('themes', 'created_by_type'))) {
    await knex.schema.alterTable('themes', (t) => {
      t.string('created_by_type', 20).nullable();
    });
  }

  if (!(await constraintExists(knex, 'chk_themes_created_by_type'))) {
    await knex.raw(
      'ALTER TABLE themes ADD CONSTRAINT chk_themes_created_by_type ' +
      "CHECK (created_by_type IS NULL OR created_by_type IN ('staff','superadmin'))",
    );
  }

  // Driven from the handful of unattributed customer themes rather than from
  // `audit_logs`: matching the other way round would scan the largest table in
  // the schema (its only index is `(gym_id, entity_type, entity_id)`, and a
  // theme-wide filter can't use the leading column) while holding write locks on
  // `themes`. One bounded statement per theme hits that index exactly, and
  // passing both ids as parameters sidesteps the collation mismatch between
  // `themes.id` (utf8mb4_unicode_ci, migration 056) and `audit_logs.entity_id`
  // (the schema default) that a direct column join would raise.
  //
  // Scoped to `created_by_name IS NULL` so it is safe to re-run and never
  // overwrites a value the application wrote after this migration.
  const [pending] = await knex.raw(
    'SELECT id, gym_id FROM themes WHERE gym_id IS NOT NULL AND created_by_name IS NULL',
  );
  for (const theme of pending) {
    await knex.raw(
      `UPDATE themes t
       JOIN audit_logs a ON a.id = (
         SELECT MIN(al.id) FROM audit_logs al
         WHERE al.gym_id = ? AND al.entity_type = 'theme' AND al.entity_id = ?
           AND al.action IN ('create', 'clone') AND al.actor_name IS NOT NULL
       )
       SET t.created_by_name = a.actor_name,
           t.modified_at     = t.modified_at
       WHERE t.id = ? AND t.created_by_name IS NULL`,
      [theme.gym_id, theme.id, theme.id],
    );
  }
};

exports.down = async (knex) => {
  if (await constraintExists(knex, 'chk_themes_created_by_type')) {
    await knex.raw('ALTER TABLE themes DROP CHECK chk_themes_created_by_type');
  }
  if (await knex.schema.hasColumn('themes', 'created_by_type')) {
    await knex.schema.alterTable('themes', (t) => t.dropColumn('created_by_type'));
  }
  if (await knex.schema.hasColumn('themes', 'created_by_name')) {
    await knex.schema.alterTable('themes', (t) => t.dropColumn('created_by_name'));
  }
};
