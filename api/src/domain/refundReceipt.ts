/**
 * #2935 — the pure rules of a Refund Receipt.
 *
 * A Refund Receipt documents one refund Payment Transaction (#2480) that
 * **completed**: a pending refund has not returned the money yet (its outcome
 * is unknown) and a failed one returned nothing, so neither is documented. It
 * has its own numbering series, distinct from a receipt's `YYYY-NNNN`, so the
 * two can never be confused or collide.
 */

/** The prefix that sets the Refund Receipt series apart from the receipts'. */
export const REFUND_RECEIPT_PREFIX = 'R';

/** `R-2026-0001`: the series' own per-gym, per-year sequence. */
export function formatRefundReceiptNumber(year: number, seq: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(seq) || seq < 1) {
    throw new Error(`Invalid refund receipt sequence: ${year}/${seq}`);
  }
  return `${REFUND_RECEIPT_PREFIX}-${year}-${String(seq).padStart(4, '0')}`;
}

/** Whether a Payment Transaction is a refund that may (still) be documented. */
export function isDocumentableRefund(tx: { transaction_type: string | null; status: string | null }): boolean {
  return tx.transaction_type === 'refund' && tx.status === 'completed';
}

/** How the PDF names the method the money went back through (the refund's own `method`). */
export function refundMethodLabel(method: string | null, snapshotName: string | null): string {
  if (snapshotName) return snapshotName;
  switch (method) {
    case 'cash': return 'Efectivo';
    case 'card_terminal': return 'Tarjeta (TPV)';
    case 'provider': return 'Tarjeta (pasarela de pago)';
    default: return method ?? '—';
  }
}
