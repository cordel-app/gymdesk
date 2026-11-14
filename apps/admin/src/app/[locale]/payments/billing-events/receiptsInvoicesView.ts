// #2806 — the Receipts & Invoices section of a Billing Event. Pure: no React,
// no `t()`. It decides only presentation: which rows the section lists (the
// receipt first, then the invoices in issue order) and whether each of the
// three Generate buttons is offered. Whether a document may be issued is the
// API's (`can_issue_receipt`, the invoice route's own checks); a button that is
// enabled here can still be refused there.

import type { InvoiceRow } from './verifactuInvoiceView';

export type DocumentKind = 'receipt' | 'simplified' | 'full';

export const DOCUMENT_KINDS: readonly DocumentKind[] = ['receipt', 'simplified', 'full'];

export interface ReceiptInfo {
  number: string | null;
  issuedAt: string | null;
}

export interface BillingDocumentRow {
  key: string;
  kind: DocumentKind;
  /** A rectifying invoice: its own row and number, linked to the original. */
  rectifying: boolean;
  number: string | null;
  issuedAt: string | null;
  /** The stored document status (`issued` | `draft`). */
  status: string;
  /** Only an invoice row carries its invoice (payment status, VERI*FACTU, PDF id). */
  invoice: InvoiceRow | null;
}

/** The documents of one Billing Event: the receipt, when issued, then every invoice. */
export function billingDocuments(receipt: ReceiptInfo, invoices: InvoiceRow[]): BillingDocumentRow[] {
  const rows: BillingDocumentRow[] = [];
  if (receipt.number) {
    rows.push({
      key: 'receipt', kind: 'receipt', rectifying: false,
      number: receipt.number, issuedAt: receipt.issuedAt, status: 'issued', invoice: null,
    });
  }
  for (const inv of invoices) {
    rows.push({
      key: `invoice-${inv.id}`, kind: inv.invoice_type, rectifying: inv.related_invoice_id != null,
      number: inv.fiscal_number, issuedAt: inv.issued_at, status: inv.status, invoice: inv,
    });
  }
  return rows;
}

/** The `billing_events_page` key a document type reads under. */
export function documentTypeKey(kind: DocumentKind): string {
  return `doc_type_${kind}`;
}

/** The `billing_events_page` key a stored document status reads under, or null for an unknown one. */
export function documentStatusKey(status: string): string | null {
  return status === 'issued' || status === 'draft' ? `doc_status_${status}` : null;
}

/** Why a Generate button is disabled, as a `billing_events_page` key. */
export type GenerateBlock = 'gen_blocked_exists' | 'gen_blocked_not_paid' | 'gen_blocked_no_amount' | 'gen_blocked_read_only';

export interface GenerateInput {
  canWrite: boolean;
  /** The API's `can_issue_receipt`: the event records money actually received. */
  canIssueReceipt: boolean;
  receiptNumber: string | null;
  amount: string | null;
  /** null while the invoices are still loading. */
  invoices: InvoiceRow[] | null;
}

/**
 * Whether each Generate button is offered. A document that already exists is
 * never generated twice from here (the API is idempotent too): it is listed
 * below with its View action instead.
 */
export function generateBlocks(input: GenerateInput): Record<DocumentKind, GenerateBlock | null> {
  const hasInvoice = (type: 'simplified' | 'full') =>
    (input.invoices ?? []).some((i) => i.invoice_type === type && i.related_invoice_id == null && i.status === 'issued');
  const amount = parseFloat(input.amount ?? '');
  const noAmount = !(amount > 0);
  const invoiceBlock = (type: 'simplified' | 'full'): GenerateBlock | null => {
    if (hasInvoice(type)) return 'gen_blocked_exists';
    if (noAmount) return 'gen_blocked_no_amount';
    if (!input.canWrite) return 'gen_blocked_read_only';
    return null;
  };
  let receipt: GenerateBlock | null = null;
  if (input.receiptNumber) receipt = 'gen_blocked_exists';
  else if (!input.canIssueReceipt) receipt = 'gen_blocked_not_paid';
  else if (!input.canWrite) receipt = 'gen_blocked_read_only';
  return { receipt, simplified: invoiceBlock('simplified'), full: invoiceBlock('full') };
}

export interface FullInvoiceForm {
  customer_name: string;
  customer_tax_id: string;
  customer_address: string;
}

/** The first missing customer field of a full invoice, as a `billing_events_page` key (the API validates too). */
export function fullInvoiceFormError(form: FullInvoiceForm): string | null {
  if (!form.customer_name.trim()) return 'full_inv_name_required';
  if (!form.customer_tax_id.trim()) return 'full_inv_tax_id_required';
  if (!form.customer_address.trim()) return 'full_inv_address_required';
  return null;
}
