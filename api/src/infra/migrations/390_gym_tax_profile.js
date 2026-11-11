/**
 * #2647 stage 1: a gym's Tax Profile and its Compliance History.
 *
 * One Gym = one legal entity = one taxpayer, so the fiscal identity stays on `gyms`.
 * Migration 114 (#185) already gave it `legal_name`, `cif` (the tax identification
 * number) and `fiscal_address` (the registered address, first line); this adds only
 * what is missing, all nullable and with no backfill, so no gym's receipts change:
 *
 *   - `country_code`          ISO 3166-1 alpha-2, the fiscal country / jurisdiction
 *   - `tax_id_type`           which identifier `cif` holds (`nif`, `nie`, `vat`, …),
 *                             judged per country by `domain/taxProfile.ts`
 *   - `fiscal_address_line2`, `fiscal_postal_code`, `fiscal_city`, `fiscal_region`
 *   - `tax_registration_date`
 *
 * No CHECK on them: `ADD CONSTRAINT` rebuilds `gyms` under ALGORITHM=COPY, and the
 * accepted sets are the domain module's, which can grow a country with no ALTER.
 *
 * `compliance_audit_events` is the append-only history of sensitive compliance
 * configuration changes, and later of tax-authority submissions (#2648). It never
 * holds a secret: `metadata` carries field names, never certificate material or a
 * password. `integration_id` is the compliance integration an event is about; its
 * table arrives in stage 2, which adds the FK.
 */

const GYM_COLUMNS = [
  ['country_code', 'CHAR(2) NULL'],
  ['tax_id_type', 'VARCHAR(20) NULL'],
  ['fiscal_address_line2', 'VARCHAR(255) NULL'],
  ['fiscal_postal_code', 'VARCHAR(20) NULL'],
  ['fiscal_city', 'VARCHAR(100) NULL'],
  ['fiscal_region', 'VARCHAR(100) NULL'],
  ['tax_registration_date', 'DATE NULL'],
];

exports.up = async (knex) => {
  for (const [col, def] of GYM_COLUMNS) {
    if (!(await knex.schema.hasColumn('gyms', col))) {
      await knex.raw(`ALTER TABLE gyms ADD COLUMN ${col} ${def}`);
    }
  }

  if (!(await knex.schema.hasTable('compliance_audit_events'))) {
    await knex.raw(`
      CREATE TABLE compliance_audit_events (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        gym_id CHAR(36) NOT NULL,
        integration_id INT UNSIGNED NULL,
        provider VARCHAR(50) NULL,
        event_type VARCHAR(50) NOT NULL,
        description VARCHAR(500) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'success',
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by VARCHAR(255) NULL,
        KEY idx_cae_gym_created (gym_id, created_at),
        CONSTRAINT fk_cae_gym FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT chk_cae_status CHECK (status IN ('success', 'failure', 'pending'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('compliance_audit_events');
  for (const [col] of [...GYM_COLUMNS].reverse()) {
    if (await knex.schema.hasColumn('gyms', col)) {
      await knex.raw(`ALTER TABLE gyms DROP COLUMN ${col}`);
    }
  }
};
