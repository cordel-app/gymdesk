// #2806 — the Receipts & Invoices section of a Billing Event. Pure: no React,
// no `t()`. It decides only presentation: which rows the section lists (the
// receipt first, then the invoices in issue order) and whether each of the
// two ⋮ menu document actions is offered (#2648 stage 6). Whether a document may be issued is the
// API's (`can_issue_receipt`, the invoice route's own checks); a button that is
// enabled here can still be refused there.

import type { InvoiceRow } from './verifactuInvoiceView';

export type DocumentKind = 'receipt' | 'simplified' | 'full' | 'refund_receipt';

export const DOCUMENT_KINDS: readonly DocumentKind[] = ['receipt', 'simplified', 'full', 'refund_receipt'];

export interface ReceiptInfo {
  number: string | null;
  issuedAt: string | null;
}

/** #3298: a Refund Receipt as the list row reports it (#2935). */
export interface RefundReceiptInfo {
  id: number;
  receipt_number: string;
  issued_at?: string | null;
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
  /** #3298: a Refund Receipt row's id (its PDF); null on every other row. */
  refundReceiptId: number | null;
  /** #3298: a superseded simplified invoice's replacement number, when the API listed it. */
  replacedByNumber: string | null;
  /** #3298 stage 2: the document links of an invoice, each the other invoice's number. */
  links: DocumentLink[];
}

/** #3298 stage 2: one link from an invoice to another invoice of the same event. */
export interface DocumentLink {
  /** The `billing_events_page` key the link reads under. */
  key: 'doc_link_rectifies' | 'doc_link_rectified_by' | 'doc_link_replaces';
  number: string;
}

/**
 * #3298 stage 2 — the links an invoice carries to the other invoices of its
 * event, all derived from the two stored references (`related_invoice_id` on a
 * rectifying invoice, `replaces_invoice_id` on a complete invoice issued in
 * place of a simplified one): a rectifying invoice names the invoice it
 * rectifies, a rectified invoice names its rectifying ones, a replacement names
 * the simplified invoice it replaces. The replaced simplified invoice's own link
 * is `replacedByNumber`. A reference to an invoice without a number links nothing.
 */
export function invoiceLinks(inv: InvoiceRow, invoices: InvoiceRow[]): DocumentLink[] {
  const numberOf = (id: number | null | undefined) =>
    id == null ? null : (invoices.find((i) => i.id === id)?.fiscal_number ?? null);
  const links: DocumentLink[] = [];
  const rectifies = numberOf(inv.related_invoice_id);
  if (rectifies) links.push({ key: 'doc_link_rectifies', number: rectifies });
  for (const other of invoices) {
    if (other.related_invoice_id === inv.id && other.fiscal_number) {
      links.push({ key: 'doc_link_rectified_by', number: other.fiscal_number });
    }
  }
  const replaces = numberOf(inv.replaces_invoice_id);
  if (replaces) links.push({ key: 'doc_link_replaces', number: replaces });
  return links;
}

/**
 * The documents of one Billing Event: the receipt, when issued, then every
 * invoice, then (#3298) every Refund Receipt — the proof that money went back,
 * a document of its own and never a fiscal invoice.
 */
export function billingDocuments(
  receipt: ReceiptInfo, invoices: InvoiceRow[], refundReceipts: RefundReceiptInfo[] = [],
): BillingDocumentRow[] {
  const rows: BillingDocumentRow[] = [];
  if (receipt.number) {
    rows.push({
      key: 'receipt', kind: 'receipt', rectifying: false,
      number: receipt.number, issuedAt: receipt.issuedAt, status: 'issued', invoice: null,
      refundReceiptId: null, replacedByNumber: null, links: [],
    });
  }
  const numberById = new Map(invoices.map((inv) => [inv.id, inv.fiscal_number]));
  for (const inv of invoices) {
    const replaced = inv.replaced_by_invoice_id != null;
    rows.push({
      key: `invoice-${inv.id}`, kind: inv.invoice_type, rectifying: inv.related_invoice_id != null,
      number: inv.fiscal_number, issuedAt: inv.issued_at,
      status: replaced ? 'replaced' : inv.status, invoice: inv,
      refundReceiptId: null,
      replacedByNumber: replaced ? (numberById.get(inv.replaced_by_invoice_id as number) ?? null) : null,
      links: invoiceLinks(inv, invoices),
    });
  }
  for (const rr of refundReceipts) {
    rows.push({
      key: `refund-receipt-${rr.id}`, kind: 'refund_receipt', rectifying: false,
      number: rr.receipt_number, issuedAt: rr.issued_at ?? null, status: 'issued', invoice: null,
      refundReceiptId: rr.id, replacedByNumber: null, links: [],
    });
  }
  return rows;
}

/**
 * The `billing_events_page` key a document type reads under (#3298: the
 * concrete type, never a generic "Invoice"; a rectifying invoice names the
 * kind of invoice it rectifies).
 */
export function documentTypeKey(kind: DocumentKind, rectifying = false): string {
  if (rectifying && (kind === 'simplified' || kind === 'full')) return `doc_type_rectifying_${kind}`;
  return `doc_type_${kind}`;
}

/** #3298: the operation chips of a Billing Event, as `billing_events_page` keys. */
export type OperationChipKey =
  | 'op_full_payment' | 'op_partial_payment' | 'op_full_refund' | 'op_partial_refund';

/**
 * #3298 — the operation chips a Billing Event carries: Full or Partial Payment
 * from the API's `payment_type`, Full or Partial Refund from its `refund_type`
 * (the same rule the Members App reads, #3297). Independent of the documents:
 * an event can be paid with no document, refunded with several.
 */
export function operationChipKeys(row: {
  payment_type?: 'full' | 'partial' | null;
  refund_type?: 'full' | 'partial' | null;
}): OperationChipKey[] {
  const keys: OperationChipKey[] = [];
  if (row.payment_type === 'full') keys.push('op_full_payment');
  else if (row.payment_type === 'partial') keys.push('op_partial_payment');
  if (row.refund_type === 'full') keys.push('op_full_refund');
  else if (row.refund_type === 'partial') keys.push('op_partial_refund');
  return keys;
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
