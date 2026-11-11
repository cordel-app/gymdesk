/**
 * #2648 stage 4: submitting VERI*FACTU records to the AEAT.
 *
 * 1. `verifactu_records.submission_status` gains `sending` (a batch holding the
 *    record is in flight) and `retry_pending` (a temporary failure: AEAT
 *    unreachable, a 5xx, a timeout, a missing credential; retried at
 *    `next_attempt_at`). `submitted` stays in the CHECK as stage 2 wrote it and
 *    nothing writes it. The set mirrors `VERIFACTU_SUBMISSION_STATUSES`
 *    (domain/verifactuRecords.ts): a new value goes in both places.
 * 2. `next_attempt_at` (NULL = due now), `last_submission_id` (the batch that
 *    last carried the record, FK SET NULL) and `aeat_csv` (the CSV AEAT returns for an
 *    accepted batch). None of them is hashed, so the record's hashed columns
 *    are still never edited.
 * 3. `verifactu_submissions`: one row per batch sent (append-only apart from
 *    the outcome columns written when the answer arrives), holding the exact
 *    request XML and the raw response, so what was informed and what AEAT
 *    answered can be audited without re-deriving anything. The request carries
 *    no secret: the certificate authenticates the TLS connection and never
 *    enters the body.
 */

async function hasConstraint(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`, [table, name]);
  return rows.length > 0;
}

async function replaceStatusCheck(knex, values) {
  if (await hasConstraint(knex, 'verifactu_records', 'chk_verifactu_records_submission_status')) {
    await knex.raw('ALTER TABLE verifactu_records DROP CHECK chk_verifactu_records_submission_status');
  }
  await knex.raw(`ALTER TABLE verifactu_records
    ADD CONSTRAINT chk_verifactu_records_submission_status CHECK (submission_status IN
      (${values.map((v) => `'${v}'`).join(', ')}))`);
}

exports.up = async (knex) => {
  await replaceStatusCheck(knex,
    ['pending', 'sending', 'submitted', 'retry_pending', 'accepted', 'accepted_with_errors', 'rejected']);

  if (!(await knex.schema.hasColumn('verifactu_records', 'next_attempt_at'))) {
    await knex.raw(`ALTER TABLE verifactu_records
      ADD COLUMN next_attempt_at DATETIME NULL AFTER last_submission_at,
      ADD COLUMN last_submission_id INT UNSIGNED NULL AFTER next_attempt_at,
      ADD COLUMN aeat_csv VARCHAR(64) NULL AFTER aeat_response_description`);
  }

  if (!(await knex.schema.hasTable('verifactu_submissions'))) {
    await knex.raw(`
      CREATE TABLE verifactu_submissions (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        gym_id CHAR(36) NOT NULL,
        integration_id INT UNSIGNED NULL,
        environment VARCHAR(20) NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'sending',
        record_count INT UNSIGNED NOT NULL,
        request_xml MEDIUMTEXT NOT NULL,
        http_status SMALLINT UNSIGNED NULL,
        response_xml MEDIUMTEXT NULL,
        aeat_csv VARCHAR(64) NULL,
        error_code VARCHAR(50) NULL,
        error_description VARCHAR(1000) NULL,
        wait_seconds INT UNSIGNED NULL,
        started_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        finished_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by VARCHAR(255) NULL,
        KEY idx_vs_gym_started (gym_id, started_at),
        CONSTRAINT chk_verifactu_submissions_status CHECK (status IN
          ('sending', 'accepted', 'partially_accepted', 'rejected', 'failed')),
        CONSTRAINT chk_verifactu_submissions_environment CHECK (environment IN ('test', 'production')),
        CONSTRAINT fk_vs_gym FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
        CONSTRAINT fk_vs_integration FOREIGN KEY (integration_id)
          REFERENCES compliance_integrations(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  if (!(await hasConstraint(knex, 'verifactu_records', 'fk_vr_last_submission'))) {
    await knex.raw(`ALTER TABLE verifactu_records ADD CONSTRAINT fk_vr_last_submission
      FOREIGN KEY (last_submission_id) REFERENCES verifactu_submissions(id) ON DELETE SET NULL`);
  }

  await knex.raw(`ALTER TABLE verifactu_records
    ADD KEY idx_vr_due (submission_status, next_attempt_at)`).catch((err) => {
    if (err && err.code === 'ER_DUP_KEYNAME') return;
    throw err;
  });
};

exports.down = async (knex) => {
  if (await hasConstraint(knex, 'verifactu_records', 'fk_vr_last_submission')) {
    await knex.raw('ALTER TABLE verifactu_records DROP FOREIGN KEY fk_vr_last_submission');
  }
  await knex.schema.dropTableIfExists('verifactu_submissions');
  await knex.raw('ALTER TABLE verifactu_records DROP INDEX idx_vr_due').catch((err) => {
    if (err && err.code === 'ER_CANT_DROP_FIELD_OR_KEY') return;
    throw err;
  });
  if (await knex.schema.hasColumn('verifactu_records', 'next_attempt_at')) {
    await knex.raw(`ALTER TABLE verifactu_records
      DROP COLUMN next_attempt_at, DROP COLUMN last_submission_id, DROP COLUMN aeat_csv`);
  }
  await knex.raw(`UPDATE verifactu_records SET submission_status = 'pending'
    WHERE submission_status IN ('sending', 'retry_pending')`);
  await replaceStatusCheck(knex, ['pending', 'submitted', 'accepted', 'accepted_with_errors', 'rejected']);
};
