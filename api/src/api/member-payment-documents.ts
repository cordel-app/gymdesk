// #2936 — the I/O half of the member's payment documents: loads the invoices
// and refund receipts of a set of the member's own Billing Events and hands
// them to `memberPaymentDocuments()`, the one place that decides what is
// offered. Reads only; nothing here issues, renders or stores a document.
import { db } from '../infra/db';
import {
  memberPaymentDocuments, type InvoiceCandidate, type MemberPaymentDocument, type RefundReceiptCandidate,
} from '../domain/memberPaymentDocuments';

export interface MemberEventRef {
  id: number;
  receipt_number: string | null;
}

/** The downloadable documents of each event, keyed by Billing Event id. */
export async function loadMemberPaymentDocuments(
  gymId: string, events: MemberEventRef[],
): Promise<Map<number, MemberPaymentDocument[]>> {
  const out = new Map<number, MemberPaymentDocument[]>();
  if (events.length === 0) return out;
  const ids = events.map((e) => Number(e.id));
  const marks = ids.map(() => '?').join(',');
  const [{ rows: invoiceRows }, { rows: refundRows }] = await Promise.all([
    db.query<any>(
      `SELECT i.id, i.billing_event_id, i.invoice_type, i.status, i.fiscal_number,
              (i.simplified_not_paid_pdf_key IS NOT NULL OR i.simplified_paid_pdf_key IS NOT NULL
                OR i.full_not_paid_pdf_key IS NOT NULL OR i.full_paid_pdf_key IS NOT NULL) AS has_document,
              EXISTS (SELECT 1 FROM invoices f WHERE f.gym_id = i.gym_id AND f.replaces_invoice_id = i.id) AS replaced
         FROM invoices i
        WHERE i.gym_id = ? AND i.billing_event_id IN (${marks})`,
      [gymId, ...ids],
    ),
    db.query<any>(
      `SELECT rr.id, rr.billing_event_id, rr.receipt_number
         FROM refund_receipts rr
        WHERE rr.gym_id = ? AND rr.billing_event_id IN (${marks})`,
      [gymId, ...ids],
    ),
  ]);
  const invoices = new Map<number, InvoiceCandidate[]>();
  for (const r of invoiceRows) {
    const list = invoices.get(Number(r.billing_event_id)) ?? [];
    list.push({
      id: Number(r.id), invoice_type: r.invoice_type, status: r.status, fiscal_number: r.fiscal_number,
      has_document: !!Number(r.has_document), replaced: !!Number(r.replaced),
    });
    invoices.set(Number(r.billing_event_id), list);
  }
  const refunds = new Map<number, RefundReceiptCandidate[]>();
  for (const r of refundRows) {
    const list = refunds.get(Number(r.billing_event_id)) ?? [];
    list.push({ id: Number(r.id), receipt_number: r.receipt_number });
    refunds.set(Number(r.billing_event_id), list);
  }
  for (const e of events) {
    out.set(Number(e.id), memberPaymentDocuments({
      billingEventId: Number(e.id),
      receiptNumber: e.receipt_number,
      invoices: invoices.get(Number(e.id)) ?? [],
      refundReceipts: refunds.get(Number(e.id)) ?? [],
    }));
  }
  return out;
}

/**
 * The Billing Event a document belongs to, when that event is the member's
 * own; null otherwise (another member's, another gym's, or unknown).
 */
export async function ownEventOfDocument(
  gymId: string, memberId: number, table: 'invoices' | 'refund_receipts', documentId: number,
): Promise<MemberEventRef | null> {
  const { rows } = await db.query<any>(
    `SELECT be.id, be.receipt_number
       FROM ${table} d
       JOIN billing_events be ON be.id = d.billing_event_id AND be.gym_id = d.gym_id
      WHERE d.id = ? AND d.gym_id = ? AND be.member_id = ?`,
    [documentId, gymId, memberId],
  );
  return rows[0] ? { id: Number(rows[0].id), receipt_number: rows[0].receipt_number } : null;
}
