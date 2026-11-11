/**
 * #2647 stage 3: Certificates & Credentials.
 *
 * `compliance_credentials` holds a credential's METADATA only: which kind it is,
 * which integration it serves, its status and, for a certificate, what the
 * certificate says about itself (subject, serial number, issuer, SHA-256
 * fingerprint, validity window). The secret material — the PKCS#12 file and its
 * password — is never in the database: it is encrypted with AES-256-GCM under
 * `COMPLIANCE_CREDENTIALS_ENCRYPTION_KEY` and written to the PRIVATE R2 bucket
 * (#2567's API-only client), and `storage_reference` is that object's key. No
 * API response returns the key, the material or the password.
 *
 * Two kinds, mirrored by `CREDENTIAL_TYPES` in `domain/complianceCredentials.ts`
 * (a new kind goes in both places):
 *   - `certificate`: customer-owned, uploaded by the gym; `storage_reference` set.
 *   - `external_reference`: centrally managed (Gymdesk or a provider holds it);
 *     `external_reference` names it, nothing is stored here.
 * `chk_cc_material` keeps the two shapes apart.
 *
 * `status` is the administrative state (`active` | `inactive`); "expired" and
 * "not yet valid" are derived on read from the validity window, never stored.
 * Several credentials per gym; deleting one is a hard delete (the history keeps
 * the event), and its object is removed from the bucket.
 */

exports.up = async (knex) => {
  if (await knex.schema.hasTable('compliance_credentials')) return;
  await knex.raw(`
    CREATE TABLE compliance_credentials (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      gym_id CHAR(36) NOT NULL,
      integration_id INT UNSIGNED NULL,
      credential_type VARCHAR(30) NOT NULL,
      label VARCHAR(120) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      storage_reference VARCHAR(512) NULL,
      external_reference VARCHAR(255) NULL,
      file_name VARCHAR(255) NULL,
      certificate_subject VARCHAR(1024) NULL,
      certificate_serial_number VARCHAR(128) NULL,
      certificate_issuer VARCHAR(1024) NULL,
      certificate_fingerprint CHAR(95) NULL,
      valid_from DATETIME NULL,
      expires_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
      created_by VARCHAR(255) NULL,
      modified_at DATETIME NULL,
      modified_by VARCHAR(255) NULL,
      KEY idx_cc_gym (gym_id),
      KEY idx_cc_integration (integration_id),
      CONSTRAINT chk_compliance_credentials_type CHECK (credential_type IN ('certificate', 'external_reference')),
      CONSTRAINT chk_compliance_credentials_status CHECK (status IN ('active', 'inactive')),
      CONSTRAINT chk_cc_material CHECK (
        (credential_type = 'certificate' AND storage_reference IS NOT NULL AND external_reference IS NULL)
        OR (credential_type = 'external_reference' AND storage_reference IS NULL AND external_reference IS NOT NULL)
      ),
      CONSTRAINT fk_cc_gym FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
      CONSTRAINT fk_cc_integration FOREIGN KEY (integration_id) REFERENCES compliance_integrations(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('compliance_credentials');
};
