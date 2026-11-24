/**
 * #3298 stage 3 — a rectifying invoice issued because of a refund names it.
 *
 *   invoices.refund_payment_request_id   the refund transaction
 *                                        (`payment_requests.transaction_type = 'refund'`)
 *                                        whose completion issued this rectifying invoice
 *
 * The refund's financial proof (its Refund Receipt, #2935) and the fiscal
 * rectifying invoice stay two records; this column is the link between them.
 * No CHECK can say the row is a refund of the same gym: its one writer,
 * `rectifyInvoiceInTx()` (through `issueRefundRectification()`), guarantees it.
 * NULL on every other invoice, including a rectification staff issued by hand:
 * no backfill. UNIQUE: a refund issues at most one rectifying invoice (NULLs
 * are not compared). FK `ON DELETE SET NULL`: a payment row deleted by the dev
 * billing reset must not block it; an invoice is never deleted.
 *
 * Repeatable (guarded). `down` drops the column with its FK and key.
 */
const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'refund_payment_request_id'`);
  return rows.length > 0;
};

exports.up = async (knex) => {
  if (await hasColumn(knex)) return;
  await knex.raw(
    `ALTER TABLE invoices
       ADD COLUMN refund_payment_request_id INT UNSIGNED NULL,
       ADD UNIQUE KEY invoices_refund_unique (refund_payment_request_id),
       ADD CONSTRAINT fk_invoices_refund FOREIGN KEY (refund_payment_request_id)
         REFERENCES payment_requests(id) ON DELETE SET NULL`);
};

exports.down = async (knex) => {
  if (!(await hasColumn(knex))) return;
  const [fk] = await knex.raw(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices' AND CONSTRAINT_NAME = 'fk_invoices_refund'`);
  if (fk.length > 0) await knex.raw('ALTER TABLE invoices DROP FOREIGN KEY fk_invoices_refund');
  await knex.raw('ALTER TABLE invoices DROP INDEX invoices_refund_unique, DROP COLUMN refund_payment_request_id');
};
