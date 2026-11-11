/**
 * #2648 stage 2: VERI*FACTU billing records.
 *
 * `verifactu_records` is the append-only chain of billing records (Registro de
 * Alta / Registro de Anulación) of a gym. One chain per gym (the gym is the SIF
 * instance): `chain_seq` numbers the records 1, 2, 3… and `UNIQUE (gym_id,
 * chain_seq)` makes a fork impossible even if two writers raced past the gym-row
 * lock the writer takes. `previous_record_id` / `previous_record_hash` name the
 * record before it (NULL for the first one); there is deliberately no self FK,
 * so deleting a whole gym (the only delete there is, by cascade) cannot trip over
 * the chain's own order.
 *
 * A record stores exactly what its huella was computed over — every field of the
 * AEAT hash string as informed (`invoice_number`, the `dd-mm-yyyy` issue date,
 * the amounts as `verifactuAmount()` spelled them, `generated_at` as
 * FechaHoraHusoGenRegistro) and the hash string itself (`hash_input`) — so the
 * hash can be recomputed and audited without re-deriving anything from the
 * invoice. Nothing edits those columns after the INSERT; the submission columns
 * are stage 4's and stay at their defaults until a submission exists.
 *
 * `UNIQUE (invoice_id, record_type)`: an invoice gets at most one Alta and one
 * Anulación, so a retried issue cannot write a second record.
 *
 * `record_type` and `submission_status` carry CHECKs mirroring
 * `VERIFACTU_RECORD_TYPES` (domain/verifactu.ts) and
 * `VERIFACTU_SUBMISSION_STATUSES` (domain/verifactuRecords.ts): a new value goes
 * in both places.
 *
 * Both FKs cascade: the application never deletes a record, and the delete
 * this is built for is a whole gym's (tests, a gym hard-delete). Note what the
 * invoice cascade also covers: `invoices` cascades from `billing_events`
 * (migration 380), so a hard-deleted event (a cancelled Pending Payment
 * version's initial event, the dev billing reset) takes an issued invoice and
 * its Alta with it, leaving a gap in the chain. RESTRICT would refuse those
 * deletes instead, which changes behaviour beyond this stage; that a billing
 * event carrying an issued invoice can be deleted at all is migration 380's
 * question, raised on the PR.
 */

exports.up = async (knex) => {
  if (await knex.schema.hasTable('verifactu_records')) return;
  await knex.raw(`
    CREATE TABLE verifactu_records (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      gym_id CHAR(36) NOT NULL,
      invoice_id INT UNSIGNED NOT NULL,
      integration_id INT UNSIGNED NULL,
      record_type VARCHAR(20) NOT NULL,
      chain_seq INT UNSIGNED NOT NULL,
      issuer_nif VARCHAR(20) NOT NULL,
      invoice_number VARCHAR(60) NOT NULL,
      invoice_issue_date VARCHAR(10) NOT NULL,
      invoice_kind VARCHAR(2) NULL,
      recipient_tax_id VARCHAR(50) NULL,
      tax_total VARCHAR(20) NULL,
      invoice_total VARCHAR(20) NULL,
      previous_record_id INT UNSIGNED NULL,
      previous_record_hash CHAR(64) NULL,
      record_hash CHAR(64) NOT NULL,
      generated_at VARCHAR(32) NOT NULL,
      hash_input TEXT NOT NULL,
      submission_status VARCHAR(30) NOT NULL DEFAULT 'pending',
      aeat_response_code VARCHAR(50) NULL,
      aeat_response_description VARCHAR(1000) NULL,
      submission_attempts INT UNSIGNED NOT NULL DEFAULT 0,
      last_submission_at DATETIME NULL,
      accepted_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
      created_by VARCHAR(255) NULL,
      UNIQUE KEY uq_vr_gym_seq (gym_id, chain_seq),
      UNIQUE KEY uq_vr_invoice_type (invoice_id, record_type),
      KEY idx_vr_gym_status (gym_id, submission_status),
      CONSTRAINT chk_verifactu_records_type CHECK (record_type IN ('alta', 'anulacion')),
      CONSTRAINT chk_verifactu_records_submission_status CHECK (submission_status IN
        ('pending', 'submitted', 'accepted', 'accepted_with_errors', 'rejected')),
      CONSTRAINT fk_vr_gym FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
      CONSTRAINT fk_vr_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
      CONSTRAINT fk_vr_integration FOREIGN KEY (integration_id)
        REFERENCES compliance_integrations(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('verifactu_records');
};
