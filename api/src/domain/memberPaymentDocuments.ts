// #2936 — which fiscal documents a member may download for one of their own
// Billing Events (Members App → My Products → Payments).
//
// Pure: the routes in `api/me.ts` load the rows, this module decides. Exactly
// one document per kind is offered — the latest applicable one — and a kind
// with no stored document is absent, never a placeholder. Nothing here creates
// a document: an invoice counts only when one of its representations is stored,
// and a receipt or refund receipt only when its number was already issued.

export const MEMBER_DOCUMENT_KINDS = ['receipt', 'simplified_invoice', 'full_invoice', 'refund_receipt'] as const;
export type MemberDocumentKind = (typeof MEMBER_DOCUMENT_KINDS)[number];

export interface MemberPaymentDocument {
  kind: MemberDocumentKind;
  /** The billing event's id for a receipt, the invoice's or refund receipt's own id otherwise. */
  id: number;
  number: string;
  /** #3242 — when the document was issued (ISO 8601, UTC); null when not recorded. */
  issued_at: string | null;
}

export interface InvoiceCandidate {
  id: number;
  invoice_type: string;
  status: string;
  fiscal_number: string | null;
  /** Whether any PDF representation (paid or not-paid) is stored. */
  has_document: boolean;
  /** Whether a complete invoice was issued in place of this one (#2648 stage 7). */
  replaced: boolean;
  issued_at: string | null;
}

export interface RefundReceiptCandidate {
  id: number;
  receipt_number: string;
  issued_at: string | null;
}

/**
 * The latest invoice of one type the member may download: issued, holding a
 * stored document and not replaced. A rectifying invoice (#2567) has a higher
 * id than the invoice it rectifies, so after a rectification it is the latest.
 */
function latestInvoice(invoices: InvoiceCandidate[], type: 'simplified' | 'full'): InvoiceCandidate | null {
  let best: InvoiceCandidate | null = null;
  for (const inv of invoices) {
    if (inv.invoice_type !== type || inv.status !== 'issued' || !inv.has_document || inv.replaced) continue;
    if (!inv.fiscal_number) continue;
    if (!best || inv.id > best.id) best = inv;
  }
  return best;
}

/** The documents of one Billing Event, in display order: receipt, invoices, refund receipt. */
export function memberPaymentDocuments(input: {
  billingEventId: number;
  receiptNumber: string | null;
  /** #3242 — `billing_events.receipt_issued_at`, when the receipt number was issued. */
  receiptIssuedAt?: string | null;
  invoices: InvoiceCandidate[];
  refundReceipts: RefundReceiptCandidate[];
}): MemberPaymentDocument[] {
  const out: MemberPaymentDocument[] = [];
  if (input.receiptNumber) {
    out.push({ kind: 'receipt', id: input.billingEventId, number: input.receiptNumber, issued_at: input.receiptIssuedAt ?? null });
  }
  const simplified = latestInvoice(input.invoices, 'simplified');
  if (simplified) out.push({ kind: 'simplified_invoice', id: simplified.id, number: simplified.fiscal_number!, issued_at: simplified.issued_at });
  const full = latestInvoice(input.invoices, 'full');
  if (full) out.push({ kind: 'full_invoice', id: full.id, number: full.fiscal_number!, issued_at: full.issued_at });
  let refund: RefundReceiptCandidate | null = null;
  for (const r of input.refundReceipts) if (!refund || r.id > refund.id) refund = r;
  if (refund) out.push({ kind: 'refund_receipt', id: refund.id, number: refund.receipt_number, issued_at: refund.issued_at });
  return out;
}
