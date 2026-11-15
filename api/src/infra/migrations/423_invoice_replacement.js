/**
 * #2648 stage 7 — a complete invoice issued in place of a simplified one.
 *
 *   invoices.replaces_invoice_id   the simplified invoice this complete invoice replaces
 *
 * When a customer asks for a complete invoice for a transaction that already has
 * an issued simplified invoice, the complete invoice is issued as a replacement
 * (VERI*FACTU TipoFactura F3, naming the simplified one in FacturasSustituidas),
 * so the transaction is not recorded twice. The simplified invoice is never
 * edited: that it was replaced is read from this column, never stored on it.
 *
 * Self FK `ON DELETE RESTRICT`, as `related_invoice_id` (migration 380): an
 * invoice is never deleted. UNIQUE: a simplified invoice is replaced at most
 * once (NULLs are not compared). Nullable with no backfill: every existing
 * invoice replaces nothing.
 *
 * Repeatable (guarded). `down` drops the column with its FK and key.
 */
const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'replaces_invoice_id'`);
  return rows.length > 0;
};

exports.up = async (knex) => {
  if (await hasColumn(knex)) return;
  await knex.raw(
    `ALTER TABLE invoices
       ADD COLUMN replaces_invoice_id INT UNSIGNED NULL,
       ADD UNIQUE KEY invoices_replaces_unique (replaces_invoice_id),
       ADD CONSTRAINT fk_invoices_replaces FOREIGN KEY (replaces_invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT`);
};

exports.down = async (knex) => {
  if (!(await hasColumn(knex))) return;
  const [fk] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND CONSTRAINT_NAME = 'fk_invoices_replaces'`);
  if (fk.length > 0) await knex.raw('ALTER TABLE invoices DROP FOREIGN KEY fk_invoices_replaces');
  await knex.raw('ALTER TABLE invoices DROP INDEX invoices_replaces_unique, DROP COLUMN replaces_invoice_id');
};
