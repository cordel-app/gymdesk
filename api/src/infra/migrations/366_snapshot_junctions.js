/**
 * #2125 / #2126 M1 — independent Product Sets assembled from immutable snapshots.
 *
 * Additive junctions (nothing reads or writes them yet; M2 writes them from the sync modules,
 * M3 moves readers, M4 makes cloneConfiguration() link instead of copy, M5 drops the version
 * columns, `is_inherited` and the legacy tables):
 *   product_set_plan_snapshots          Product Set <-> Membership Plan snapshot
 *   product_set_session_snapshots       Product Set <-> recurring Product snapshot, one junction per
 *   product_set_oneoff_snapshots        snapshot table so each keeps a real FK (a `kind` + id pair
 *   product_set_periodical_snapshots    could not carry one)
 *   billing_event_oneoff_snapshots      Billing Event <-> bought one-time Product snapshot
 * Each is UNIQUE on its pair; FK to the owner CASCADE, to the snapshot RESTRICT (immutable).
 *
 * Billing history: development only, by the owner's decision, nothing is migrated.
 * `billing_events` is emptied; payment_requests / member_products keep their rows (their
 * billing_event_id FK is ON DELETE SET NULL) and billing_event_lines cascade. Refused in
 * production unless ALLOW_CLEAR_BILLING_HISTORY=1. `down` drops the junctions only.
 */
const JUNCTIONS = [
  ['product_set_plan_snapshots', 'psps', 'product_set_id', 'product_sets', 'plan_snapshot_id', 'plan_snapshots'],
  ['product_set_session_snapshots', 'pssn', 'product_set_id', 'product_sets', 'product_session_snapshot_id', 'product_session_snapshots'],
  ['product_set_oneoff_snapshots', 'psosn', 'product_set_id', 'product_sets', 'product_oneoff_snapshot_id', 'product_oneoff_snapshots'],
  ['product_set_periodical_snapshots', 'pspsn', 'product_set_id', 'product_sets', 'product_periodical_snapshot_id', 'product_periodical_snapshots'],
  ['billing_event_oneoff_snapshots', 'beosn', 'billing_event_id', 'billing_events', 'product_oneoff_snapshot_id', 'product_oneoff_snapshots'],
];

exports.up = async (knex) => {
  const [[{ n }]] = await knex.raw('SELECT COUNT(*) AS n FROM billing_events');
  if (n > 0) {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_CLEAR_BILLING_HISTORY !== '1') {
      throw new Error('Refusing to clear billing_events in production (set ALLOW_CLEAR_BILLING_HISTORY=1 to override)');
    }
    await knex.raw('DELETE FROM billing_events');
  }
  for (const [name, abbr, ownerCol, ownerTable, snapCol, snapTable] of JUNCTIONS) {
    if (await knex.schema.hasTable(name)) continue;
    await knex.raw(`
      CREATE TABLE ${name} (
        id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
        ${ownerCol}  INT UNSIGNED NOT NULL,
        ${snapCol}   INT UNSIGNED NOT NULL,
        created_at   DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY ${abbr}_pair_key (${ownerCol}, ${snapCol}),
        KEY ${abbr}_snapshot_index (${snapCol}),
        CONSTRAINT ${abbr}_owner_fk FOREIGN KEY (${ownerCol}) REFERENCES ${ownerTable} (id) ON DELETE CASCADE,
        CONSTRAINT ${abbr}_snapshot_fk FOREIGN KEY (${snapCol}) REFERENCES ${snapTable} (id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
};

exports.down = async (knex) => {
  for (const [name] of [...JUNCTIONS].reverse()) await knex.schema.dropTableIfExists(name);
};
