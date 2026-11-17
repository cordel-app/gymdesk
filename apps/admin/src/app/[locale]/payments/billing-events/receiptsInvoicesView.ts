// #2806 — the Receipts & Invoices section of a Billing Event. Pure: no React,
// no `t()`. It decides only presentation: which rows the section lists (the
// receipt first, then the invoices in issue order) and whether each of the
// two ⋮ menu document actions is offered (#2648 stage 6). Whether a document may be issued is the
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
  /** The document status: the stored one (`issued` | `draft`), or `replaced` for a simplified invoice a complete one replaced (#2648 stage 7). */
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
      number: inv.fiscal_number, issuedAt: inv.issued_at,
      status: inv.replaced_by_invoice_id != null ? 'replaced' : inv.status, invoice: inv,
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
  return status === 'issued' || status === 'draft' || status === 'replaced' ? `doc_status_${status}` : null;
}

/** Why a ⋮ menu document action is disabled, as a `billing_events_page` key. */
export type GenerateBlock = 'gen_blocked_exists' | 'gen_blocked_not_paid' | 'gen_blocked_no_amount' | 'gen_blocked_read_only';

/** The two document actions of a Billing Event's ⋮ menu (#2648 stage 6). */
export type MenuDocumentAction = 'receipt' | 'full';

export interface MenuDocumentInput {
  canWrite: boolean;
  /** The API's `can_issue_receipt`: the event records money actually received. */
  canIssueReceipt: boolean;
  /** Already issued: the receipt action then re-opens it. */
  receiptNumber: string | null;
  amount: string | null;
  /** The API's `has_full_invoice`. */
  hasFullInvoice: boolean;
}

/**
 * #2648 stage 6 — whether each ⋮ menu document action is offered. There is no
 * simplified-invoice action: the system issues it (on the billing date of a
 * scheduled obligation, or when any other event is paid). A receipt waits for
 * the payment; a complete invoice is offered paid or not, once per event.
 */
export function menuDocumentBlocks(input: MenuDocumentInput): Record<MenuDocumentAction, GenerateBlock | null> {
  const amount = parseFloat(input.amount ?? '');
  let receipt: GenerateBlock | null = null;
  if (!input.canIssueReceipt) receipt = 'gen_blocked_not_paid';
  else if (!input.receiptNumber && !input.canWrite) receipt = 'gen_blocked_read_only';
  let full: GenerateBlock | null = null;
  if (input.hasFullInvoice) full = 'gen_blocked_exists';
  else if (!(amount > 0)) full = 'gen_blocked_no_amount';
  else if (!input.canWrite) full = 'gen_blocked_read_only';
  return { receipt, full };
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

/**
 * #2935: the ⋮ menu's *View Refund Receipt* entries, one per Refund Receipt the
 * API reported (oldest first). With several partial refunds each entry names
 * its number so they can be told apart. Refund Receipts are issued by the
 * system when a refund completes, so there is no Generate entry.
 */
export function refundReceiptMenuEntries(
  receipts: { id: number; receipt_number: string }[] | null | undefined,
): { id: number; labelKey: 'view_refund_receipt' | 'view_refund_receipt_numbered'; number: string }[] {
  const list = receipts ?? [];
  return list.map((r) => ({
    id: r.id,
    labelKey: list.length > 1 ? 'view_refund_receipt_numbered' : 'view_refund_receipt',
    number: r.receipt_number,
  }));
}
