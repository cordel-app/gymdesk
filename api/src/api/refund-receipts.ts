import { db, type Tx } from '../infra/db';
import { formatRefundReceiptNumber, isDocumentableRefund, refundMethodLabel } from '../domain/refundReceipt';
import { buildRefundReceiptKey } from '../domain/billingDocumentKeys';
import { generateRefundReceiptPdf } from '../lib/refund-receipt-pdf';
import {
  isPrivateStorageConfigured, putPrivateDocument, getPrivateDocument,
} from '../infra/private-storage';

/**
 * #2935 — Refund Receipts. `issueRefundReceipt()` is the one writer of
 * `refund_receipts` and of its own gapless series (`refund_receipt_sequences`),
 * called by the refund writer (`billing-event-refunds.ts`) the moment a refund
 * transaction completes, and by nothing else: a pending or failed refund is
 * never documented. The original receipt, invoices and the refund transaction
 * itself are never written here.
 */

type Exec = Pick<Tx, 'query'>;

export interface IssuedRefundReceipt {
  id: number;
  receiptNumber: string;
  allocated: boolean;
}

/**
 * Returns the refund's receipt, allocating its number on first call. The
 * refund row is read `FOR UPDATE` first, so two concurrent callers never burn
 * two numbers for one refund (the `UNIQUE (payment_request_id)` is the
 * backstop). Returns null when the transaction is not a completed refund of
 * this gym — nothing is allocated for it.
 */
export async function issueRefundReceipt(
  tx: Tx,
  gymId: string,
  refundPaymentRequestId: number,
  actor: string | null,
): Promise<IssuedRefundReceipt | null> {
  const { rows } = await tx.query<any>(
    `SELECT r.id, r.status, r.transaction_type, r.refund_of_payment_request_id, o.billing_event_id
       FROM payment_requests r
       JOIN payment_requests o ON o.id = r.refund_of_payment_request_id
      WHERE r.id = ? AND r.gym_id = ? FOR UPDATE`,
    [refundPaymentRequestId, gymId],
  );
  const refund = rows[0];
  if (!refund || !isDocumentableRefund(refund) || refund.billing_event_id == null) return null;

  const { rows: existing } = await tx.query<any>(
    'SELECT id, receipt_number FROM refund_receipts WHERE payment_request_id = ?',
    [refundPaymentRequestId],
  );
  if (existing[0]) {
    return { id: Number(existing[0].id), receiptNumber: existing[0].receipt_number, allocated: false };
  }

  // The year the refund receipt is issued in, as for a receipt (#787).
  const year = new Date().getUTCFullYear();
  await tx.query(
    'INSERT IGNORE INTO refund_receipt_sequences (gym_id, year, last_seq) VALUES (?, ?, 0)',
    [gymId, year],
  );
  await tx.query(
    'UPDATE refund_receipt_sequences SET last_seq = last_seq + 1 WHERE gym_id = ? AND year = ?',
    [gymId, year],
  );
  const { rows: seq } = await tx.query<{ last_seq: number }>(
    'SELECT last_seq FROM refund_receipt_sequences WHERE gym_id = ? AND year = ?',
    [gymId, year],
  );
  const receiptNumber = formatRefundReceiptNumber(year, Number(seq[0].last_seq));
  const { insertId } = await tx.query(
    `INSERT INTO refund_receipts
       (gym_id, payment_request_id, original_payment_request_id, billing_event_id, receipt_number, issued_at, created_by)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
    [gymId, refundPaymentRequestId, refund.refund_of_payment_request_id, refund.billing_event_id, receiptNumber, actor],
  );
  return { id: Number(insertId), receiptNumber, allocated: true };
}

export interface RefundReceiptSummary {
  id: number;
  receipt_number: string;
  issued_at: Date;
  payment_request_id: number;
  amount: string;
  currency: string;
}

/** The Refund Receipts of a page of Billing Events, oldest first per event. */
export async function loadRefundReceiptsForEvents(
  exec: Exec, gymId: string, billingEventIds: number[],
): Promise<Map<number, RefundReceiptSummary[]>> {
  const out = new Map<number, RefundReceiptSummary[]>();
  if (billingEventIds.length === 0) return out;
  const { rows } = await exec.query<any>(
    `SELECT rr.id, rr.billing_event_id, rr.receipt_number, rr.issued_at, rr.payment_request_id,
            r.amount, r.currency
       FROM refund_receipts rr
       JOIN payment_requests r ON r.id = rr.payment_request_id
      WHERE rr.gym_id = ? AND rr.billing_event_id IN (${billingEventIds.map(() => '?').join(',')})
      ORDER BY rr.id`,
    [gymId, ...billingEventIds],
  );
  for (const r of rows) {
    const id = Number(r.billing_event_id);
    const list = out.get(id) ?? [];
    list.push({
      id: Number(r.id), receipt_number: r.receipt_number, issued_at: r.issued_at,
      payment_request_id: Number(r.payment_request_id), amount: String(r.amount), currency: r.currency ?? 'EUR',
    });
    out.set(id, list);
  }
  return out;
}

async function render(gymId: string, refundReceiptId: number): Promise<{ pdf: Buffer; row: any } | null> {
  const { rows } = await db.query<any>(
    `SELECT rr.id, rr.receipt_number, rr.issued_at, rr.billing_event_id, rr.payment_request_id,
            r.amount AS refund_amount, r.currency, r.method AS refund_method, r.payment_method_name AS refund_method_name,
            r.provider_refund_ref, r.completed_at AS refund_completed_at, r.created_at AS refund_created_at, r.notes,
            o.amount AS original_amount, o.completed_at AS original_completed_at,
            be.receipt_number AS original_receipt_number,
            COALESCE(r.payer_member_id, r.member_id) AS customer_member_id,
            g.name AS gym_name, g.legal_name, g.cif, g.fiscal_address, g.fiscal_phone,
            m.name AS member_name, m.nif_nie_passport,
            (SELECT i.customer_tax_id FROM invoices i
              WHERE i.billing_event_id = rr.billing_event_id AND i.gym_id = rr.gym_id
                AND i.invoice_type = 'full' AND i.status = 'issued'
              ORDER BY i.id DESC LIMIT 1) AS invoice_tax_id,
            (SELECT i.customer_address FROM invoices i
              WHERE i.billing_event_id = rr.billing_event_id AND i.gym_id = rr.gym_id
                AND i.invoice_type = 'full' AND i.status = 'issued'
              ORDER BY i.id DESC LIMIT 1) AS invoice_address,
            (SELECT GROUP_CONCAT(bel.item_name ORDER BY bel.id SEPARATOR ', ')
               FROM payment_refund_lines prl JOIN billing_event_lines bel ON bel.id = prl.billing_event_line_id
              WHERE prl.payment_request_id = rr.payment_request_id) AS refunded_lines
       FROM refund_receipts rr
       JOIN payment_requests r ON r.id = rr.payment_request_id
       JOIN payment_requests o ON o.id = rr.original_payment_request_id
       JOIN billing_events be ON be.id = rr.billing_event_id
       JOIN gyms g ON g.id = rr.gym_id
       LEFT JOIN members m ON m.id = COALESCE(r.payer_member_id, r.member_id)
      WHERE rr.id = ? AND rr.gym_id = ?`,
    [refundReceiptId, gymId],
  );
  const row = rows[0];
  if (!row) return null;
  const pdf = await generateRefundReceiptPdf({
    refundReceiptNumber: row.receipt_number,
    issuedAt: new Date(row.issued_at),
    gym: {
      name: row.gym_name, legalName: row.legal_name, cif: row.cif,
      fiscalAddress: row.fiscal_address, fiscalPhone: row.fiscal_phone,
    },
    customer: {
      name: row.member_name ?? '—',
      taxId: row.invoice_tax_id ?? row.nif_nie_passport ?? null,
      address: row.invoice_address ?? null,
    },
    refund: {
      completedAt: new Date(row.refund_completed_at ?? row.refund_created_at),
      amount: Number(row.refund_amount),
      currency: row.currency ?? 'EUR',
      method: refundMethodLabel(row.refund_method, row.refund_method_name),
      reference: row.provider_refund_ref ?? `#${row.payment_request_id ?? refundReceiptId}`,
      reason: row.refunded_lines ? `Líneas: ${row.refunded_lines}` : null,
    },
    original: {
      receiptNumber: row.original_receipt_number ?? null,
      paidAt: row.original_completed_at ? new Date(row.original_completed_at) : null,
      amount: Number(row.original_amount),
      billingEventId: Number(row.billing_event_id),
    },
  });
  return { pdf, row };
}

/**
 * The Refund Receipt's PDF: the stored document when there is one, otherwise
 * rendered (and, with private storage configured, stored once and pointed to
 * by `refund_receipts.pdf_key`). Null when the receipt is not this gym's.
 */
export async function refundReceiptPdf(
  gymId: string, refundReceiptId: number,
): Promise<{ pdf: Buffer; receiptNumber: string } | null> {
  const { rows } = await db.query<any>(
    'SELECT id, receipt_number, pdf_key FROM refund_receipts WHERE id = ? AND gym_id = ?',
    [refundReceiptId, gymId],
  );
  const stored = rows[0];
  if (!stored) return null;
  if (stored.pdf_key && isPrivateStorageConfigured()) {
    return { pdf: (await getPrivateDocument(stored.pdf_key)).body, receiptNumber: stored.receipt_number };
  }
  const rendered = await render(gymId, refundReceiptId);
  if (!rendered) return null;
  if (!isPrivateStorageConfigured()) return { pdf: rendered.pdf, receiptNumber: stored.receipt_number };

  const key = buildRefundReceiptKey(gymId, rendered.row.gym_name, refundReceiptId);
  try {
    await putPrivateDocument(key, rendered.pdf);
  } catch (err: any) {
    // Never overwrite: a concurrent caller already stored it — serve that one.
    if (!/already exists/.test(String(err?.message))) throw err;
    await db.query('UPDATE refund_receipts SET pdf_key = ? WHERE id = ? AND pdf_key IS NULL', [key, refundReceiptId]);
    return { pdf: (await getPrivateDocument(key)).body, receiptNumber: stored.receipt_number };
  }
  await db.query('UPDATE refund_receipts SET pdf_key = ? WHERE id = ? AND pdf_key IS NULL', [key, refundReceiptId]);
  return { pdf: rendered.pdf, receiptNumber: stored.receipt_number };
}
