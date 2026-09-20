/**
 * #599: Website self-registration.
 *
 * A gym's public website (WordPress) calls POST /public/gyms/:slug/registrations
 * server-to-server, authenticated by a per-gym API key. Only the SHA-256 of the
 * key is stored — the key is 32 random bytes, so a fast hash is appropriate
 * (there is no low-entropy secret to stretch). `website_api_key_prefix` is
 * display-only, so an admin can tell which key is live without ever seeing it.
 *
 * One key per gym, so the columns live on `gyms` rather than in a new table.
 * Also seeds the `system.website_integration` navigation flag. It is seeded
 * enabled on purpose: the feature ships complete in this migration's PR, and
 * the page is inert until an admin generates a key.
 *
 * Gym rows are read with `SELECT g.*` in api/gyms.ts — `stripGymSecrets` there
 * keeps the hash out of responses and audit payloads.
 */
const COLUMNS = [
  ['website_api_key_hash', 'CHAR(64) NULL'],
  ['website_api_key_prefix', 'VARCHAR(16) NULL'],
  ['website_api_key_created_at', 'DATETIME NULL'],
];

exports.up = async (knex) => {
  for (const [name, ddl] of COLUMNS) {
    if (!(await knex.schema.hasColumn('gyms', name))) {
      await knex.raw(`ALTER TABLE gyms ADD COLUMN ${name} ${ddl}`);
    }
  }
  await knex.raw(
    'INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at) VALUES (?, 1, UTC_TIMESTAMP())',
    ['system.website_integration'],
  );
};

// WARNING: destructive — drops every gym's website API key hash. Keys cannot be
// recovered; each gym must generate a new key and reconfigure its website.
exports.down = async (knex) => {
  await knex.raw("DELETE FROM feature_flags WHERE feature_key = 'system.website_integration'");
  for (const [name] of [...COLUMNS].reverse()) {
    if (await knex.schema.hasColumn('gyms', name)) {
      await knex.raw(`ALTER TABLE gyms DROP COLUMN ${name}`);
    }
  }
};
