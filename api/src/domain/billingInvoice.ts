// #2567 stage 3 — the pure rules of a fiscal invoice: what a Full Invoice's
// customer data must hold, how a fiscal number reads, which PDF
// representations exist and what the diagonal stamp says. No I/O here.
import type { InvoiceType, InvoicePaymentState } from './billingDocumentKeys';

export const INVOICE_LANGUAGES = ['en', 'es', 'ca'] as const;
export type InvoiceLanguage = (typeof INVOICE_LANGUAGES)[number];

export function invoiceLanguage(locale: string | null | undefined): InvoiceLanguage {
  const l = String(locale ?? '').toLowerCase().slice(0, 2);
  return (INVOICE_LANGUAGES as readonly string[]).includes(l) ? (l as InvoiceLanguage) : 'es';
}

const STAMP: Record<InvoiceLanguage, Record<InvoicePaymentState, string>> = {
  en: { paid: 'PAID', 'not-paid': 'NOT PAID' },
  es: { paid: 'PAGADA', 'not-paid': 'NO PAGADA' },
  ca: { paid: 'PAGADA', 'not-paid': 'NO PAGADA' },
};
export function stampText(lang: InvoiceLanguage, state: InvoicePaymentState): string {
  return STAMP[lang][state];
}

export interface CustomerInput { name: string; taxId: string; address: string }

/** A Full Invoice needs all three fields; returns the cleaned data or the first error. */
export function parseCustomerInput(body: unknown): { ok: true; value: CustomerInput } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = clean(b.customer_name);
  const taxId = clean(b.customer_tax_id);
  const address = clean(b.customer_address);
  if (!name) return { ok: false, error: 'customer_name is required' };
  if (!taxId) return { ok: false, error: 'customer_tax_id is required' };
  if (!address) return { ok: false, error: 'customer_address is required' };
  if (name.length > 255) return { ok: false, error: 'customer_name is too long' };
  if (taxId.length > 50) return { ok: false, error: 'customer_tax_id is too long' };
  if (address.length > 2000) return { ok: false, error: 'customer_address is too long' };
  return { ok: true, value: { name, taxId, address } };
}

/** `S-2026-0001` (simplified) / `F-2026-0001` (full): its own series per type. */
export function formatFiscalNumber(type: InvoiceType, year: number, seq: number): string {
  return `${type === 'simplified' ? 'S' : 'F'}-${year}-${String(seq).padStart(4, '0')}`;
}
/** `R-2026-0001`: the rectifying series, one per gym and year, whatever the original's type. */
export function formatRectifyingNumber(year: number, seq: number): string {
  return `R-${year}-${String(seq).padStart(4, '0')}`;
}

/** A rectification needs a reason; returns the cleaned text or the error. */
export function parseRectificationReason(body: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) return { ok: false, error: 'reason is required' };
  if (reason.length > 500) return { ok: false, error: 'reason is too long' };
  return { ok: true, value: reason };
}

/** The rectifying invoice cancels the original in full: every figure is negated. */
export function negateLines(lines: LineInput[]): LineInput[] {
  return lines.map((l) => ({
    ...l,
    amount: -l.amount,
    amountExclTax: l.amountExclTax == null ? null : -l.amountExclTax,
  }));
}
export function negateTotals(t: TaxBreakdown): TaxBreakdown {
  return { net: -t.net, tax: -t.tax, total: -t.total };
}

export function parseFiscalSeq(number: string): number {
  const m = /-(\d+)$/.exec(number);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Which representations a payment state needs. Generated unpaid: the unpaid
 * one only (the paid one follows the payment). Generated paid: the paid one
 * only. An already-paid invoice never gets an unpaid PDF.
 */
export function representationToCreate(paid: boolean): InvoicePaymentState {
  return paid ? 'paid' : 'not-paid';
}

export interface LineInput { name: string; quantity: number; amount: number; amountExclTax: number | null; taxRate: number | null }
export interface TaxBreakdown { net: number; tax: number; total: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Net/tax/total of the event from its lines; the total is always the event amount. */
export function taxBreakdown(lines: LineInput[], total: number, fallbackRate: number): TaxBreakdown {
  let net = 0;
  for (const l of lines) {
    const rate = l.taxRate ?? fallbackRate;
    net += l.amountExclTax ?? l.amount / (1 + rate / 100);
  }
  if (lines.length === 0) net = total / (1 + fallbackRate / 100);
  net = r2(net);
  return { net, tax: r2(total - net), total: r2(total) };
}

// ── #2648 stage 6: automatic simplified invoices ────────────────────────────
// A simplified invoice is issued by the system, never by a staff button:
//  - a scheduled obligation (a Billing Event generated from a schedule) on its
//    billing date, paid or not — the nightly billing run;
//  - any other event (a checkout's initial payment, a purchase, a manual
//    append) when it is paid — the settle paths.
// Issued once per event: an event that already holds an issued invoice of
// either type (a rectifying one aside) gets nothing, so one transaction is
// never invoiced twice. A payment received later only adds the paid
// representation of the invoice already issued (#2567 stage 3).

/**
 * The event types a simplified invoice is issued for: those a payment can be
 * received on (`RECEIPTABLE_EVENT_TYPES`, #787) plus `charge_created`, the type
 * a scheduled obligation keeps until it is charged — it is invoiced on its
 * billing date whether or not a charge was attempted.
 */
export function autoInvoiceEventTypes(receiptable: readonly string[]): string[] {
  return [...receiptable, 'charge_created'];
}

/** How far back the nightly pass looks for a billing date it has not invoiced. */
export const AUTO_INVOICE_CATCH_UP_DAYS = 7;
/** At most this many invoices issued per nightly pass. */
export const AUTO_INVOICE_BATCH_SIZE = 500;

export interface AutoInvoiceInput {
  eventType: string;
  amount: number;
  cancelled: boolean;
  /** An issued invoice (simplified or full, not rectifying) already exists for the event. */
  hasInvoice: boolean;
  /** `autoInvoiceEventTypes()`. */
  invoiceableTypes: readonly string[];
}

/** Whether the system issues the event's simplified invoice now. */
export function shouldAutoIssueSimplified(i: AutoInvoiceInput): boolean {
  if (i.hasInvoice || i.cancelled) return false;
  if (!(i.amount > 0)) return false;
  return i.invoiceableTypes.includes(i.eventType);
}

/** The earliest billing date the nightly pass still invoices (`YYYY-MM-DD`). */
export function autoInvoiceFromDate(today: string, days = AUTO_INVOICE_CATCH_UP_DAYS): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
