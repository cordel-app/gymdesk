/**
 * #2647 stage 2: a gym's Tax Configuration and its Electronic Invoicing integrations.
 *
 * `gym_tax_configs` is one row per gym (UNIQUE gym_id): the tax regime, the VAT
 * registration status, the default tax calculation method and any additional
 * fiscal identification the jurisdiction needs, plus a country-specific
 * `configuration_metadata` JSON object. The accepted values are per country and
 * live in `api/src/domain/taxConfiguration.ts`, so there is no CHECK on them (a
 * country is added there with no ALTER). Nothing reads this row when a price, a
 * tax or an invoice is computed: storing a configuration changes no billing.
 *
 * `compliance_integrations` holds the electronic-invoicing integrations a gym has
 * configured (VeriFactu first, #2648). Several per gym, but one per
 * (provider, integration_type) — `uq_ci_gym_provider_type`. `authorization_status` is
 * the one country-independent vocabulary, so it carries a CHECK mirroring
 * `AUTHORIZATION_STATUSES` (a new status goes in both places); regimes, statuses,
 * methods, providers and types are per country and have none. Nothing calls a tax
 * authority from here; `enabled` and the authorization columns are configuration.
 * An integration is never deleted, it is disabled, so its history stays readable.
 *
 * `compliance_audit_events.integration_id` (migration 390) gets its FK now that the
 * table exists, SET NULL so an event outlives a row nothing deletes today anyway.
 *
 * `metadata` never carries a secret: credentials are stage 3's own table.
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('gym_tax_configs'))) {
    await knex.raw(`
      CREATE TABLE gym_tax_configs (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        gym_id CHAR(36) NOT NULL,
        tax_regime VARCHAR(50) NULL,
        tax_status VARCHAR(30) NULL,
        tax_calculation_method VARCHAR(20) NULL,
        additional_tax_identification VARCHAR(255) NULL,
        configuration_metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by VARCHAR(255) NULL,
        modified_at DATETIME NULL,
        modified_by VARCHAR(255) NULL,
        UNIQUE KEY uq_gtc_gym (gym_id),
        CONSTRAINT fk_gtc_gym FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  if (!(await knex.schema.hasTable('compliance_integrations'))) {
    await knex.raw(`
      CREATE TABLE compliance_integrations (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        gym_id CHAR(36) NOT NULL,
        country_code CHAR(2) NOT NULL,
        provider VARCHAR(50) NOT NULL,
        integration_type VARCHAR(50) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        authorization_status VARCHAR(30) NOT NULL DEFAULT 'not_started',
        authorization_date DATE NULL,
        authorization_reference VARCHAR(255) NULL,
        activation_date DATE NULL,
        configuration_metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by VARCHAR(255) NULL,
        modified_at DATETIME NULL,
        modified_by VARCHAR(255) NULL,
        UNIQUE KEY uq_ci_gym_provider_type (gym_id, provider, integration_type),
        CONSTRAINT chk_compliance_integrations_authorization_status CHECK (authorization_status IN
          ('not_started', 'pending', 'authorized', 'rejected', 'revoked')),
        CONSTRAINT fk_ci_gym FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  const [fk] = await knex.raw(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'compliance_audit_events'
        AND CONSTRAINT_NAME = 'fk_cae_integration'`,
  );
  if (fk.length === 0) {
    await knex.raw(`
      ALTER TABLE compliance_audit_events
        ADD KEY idx_cae_integration (integration_id),
        ADD CONSTRAINT fk_cae_integration FOREIGN KEY (integration_id)
          REFERENCES compliance_integrations(id) ON DELETE SET NULL
    `);
  }
};

exports.down = async (knex) => {
  const [fk] = await knex.raw(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'compliance_audit_events'
        AND CONSTRAINT_NAME = 'fk_cae_integration'`,
  );
  if (fk.length > 0) {
    await knex.raw('ALTER TABLE compliance_audit_events DROP FOREIGN KEY fk_cae_integration');
  }
  const [idx] = await knex.raw(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'compliance_audit_events'
        AND INDEX_NAME = 'idx_cae_integration'`,
  );
  if (idx.length > 0) {
    await knex.raw('ALTER TABLE compliance_audit_events DROP KEY idx_cae_integration');
  }
  await knex.schema.dropTableIfExists('compliance_integrations');
  await knex.schema.dropTableIfExists('gym_tax_configs');
};
