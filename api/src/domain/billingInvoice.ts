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
export function negateLines<L extends LineInput>(lines: L[]): L[] {
  return lines.map((l) => {
    const out: any = {
      ...l,
      amount: -l.amount,
      amountExclTax: l.amountExclTax == null ? null : -l.amountExclTax,
    };
    if (typeof (l as any).net === 'number') out.net = -(l as any).net;
    if (typeof (l as any).tax === 'number') out.tax = -(l as any).tax;
    return out as L;
  });
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

/**
 * #2884: one line of a receipt or invoice with its own tax rate, net and tax.
 * `amount` stays VAT-inclusive; `net + tax = amount` to the cent.
 */
export interface InvoiceLine extends LineInput { rate: number; net: number; tax: number }

/**
 * The rate a line is stated at: its own stored rate; else, when only its net was
 * stored, the rate that net implies; else the gym's system rate. A document
 * never applies one rate to lines that carry their own.
 */
export function lineTaxRate(l: LineInput, fallbackRate: number): number {
  if (l.taxRate != null) return l.taxRate;
  if (l.amountExclTax != null && l.amountExclTax !== 0) return r2((l.amount / l.amountExclTax - 1) * 100);
  return fallbackRate;
}

/**
 * #2884 — every line's rate, net and tax, plus the document totals built from
 * them, so `Σ line tax = tax total`, `Σ line net = net total` and
 * `net + tax = total`. The total is always the event amount (the figure the
 * VERI*FACTU record informs); the lines restate the engine and sum to it, and
 * if a legacy event's lines leave a cent of rounding over it lands on the
 * largest line's tax, so the document still reconciles. The one place a
 * receipt's or an invoice's per-line tax is decided.
 */
export function invoiceLineTaxes(
  lines: LineInput[], total: number, fallbackRate: number,
): { lines: InvoiceLine[]; totals: TaxBreakdown } {
  const cents = (n: number) => Math.round(n * 100);
  const out: InvoiceLine[] = lines.map((l) => {
    const rate = lineTaxRate(l, fallbackRate);
    const net = r2(l.amountExclTax ?? l.amount / (1 + rate / 100));
    return { ...l, rate, net, tax: r2(l.amount - net) };
  });
  if (out.length === 0) {
    const net = r2(total / (1 + fallbackRate / 100));
    return { lines: [], totals: { net, tax: r2(total - net), total: r2(total) } };
  }
  const residual = cents(total) - out.reduce((s, l) => s + cents(l.net) + cents(l.tax), 0);
  if (residual !== 0) {
    const largest = out.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
    largest.tax = r2(largest.tax + residual / 100);
  }
  const net = out.reduce((s, l) => s + cents(l.net), 0) / 100;
  const tax = out.reduce((s, l) => s + cents(l.tax), 0) / 100;
  return { lines: out, totals: { net, tax, total: r2(total) } };
}

/** Net/tax/total of the event from its lines; the total is always the event amount. */
export function taxBreakdown(lines: LineInput[], total: number, fallbackRate: number): TaxBreakdown {
  return invoiceLineTaxes(lines, total, fallbackRate).totals;
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

// ── #2648 stage 7: a complete invoice in place of a simplified one ──────────
// A complete invoice requested for a transaction that already has an issued
// simplified invoice is issued as its replacement (VERI*FACTU F3, naming the
// simplified one), so the one transaction is never recorded twice. The
// simplified invoice is never edited; that it was replaced is derived from the
// replacement's `replaces_invoice_id`.

export interface EventInvoiceState {
  id: number;
  invoiceType: 'simplified' | 'full';
  status: string;
  /** Set on a rectifying invoice. */
  relatedInvoiceId: number | null;
  /** Set on a complete invoice issued in place of a simplified one. */
  replacesInvoiceId: number | null;
  /** The invoice's VERI*FACTU record was cancelled (Registro de Anulación). */
  hasAnulacion: boolean;
}

/**
 * The simplified invoice of an event a new complete invoice replaces, or null
 * when the complete invoice is an ordinary one (F1). Only an issued simplified
 * invoice that still stands may be replaced: not a rectifying one, not one a
 * rectifying invoice cancelled, not one already replaced and not one whose
 * VERI*FACTU record was cancelled (each of those leaves no standing simplified
 * invoice to replace). The oldest one when, exceptionally, there are several.
 */
export function replacementTarget(invoices: EventInvoiceState[]): number | null {
  const rectified = new Set(invoices.map((i) => i.relatedInvoiceId).filter((id): id is number => id != null));
  const replaced = new Set(invoices.map((i) => i.replacesInvoiceId).filter((id): id is number => id != null));
  const candidates = invoices.filter((i) => i.invoiceType === 'simplified' && i.status === 'issued'
    && i.relatedInvoiceId == null && !rectified.has(i.id) && !replaced.has(i.id) && !i.hasAnulacion);
  if (candidates.length === 0) return null;
  return candidates.reduce((m, i) => (i.id < m ? i.id : m), candidates[0].id);
}
