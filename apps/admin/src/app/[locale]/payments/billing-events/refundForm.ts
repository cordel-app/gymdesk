/**
 * #2480 — the Refund modal's arithmetic and payload. JSX-free and decides
 * nothing the server does not re-check: the refundable amounts come from
 * `GET /payments/billing-events/:id/refund-options`, and the server judges the
 * request again under the event's lock. This module only sums what the
 * administrator selected (in cents, so 0.10 + 0.20 is 0.30) and says whether
 * Accept may be pressed.
 */

export type RefundKind = 'full' | 'lines' | 'adhoc';
export type RefundMethodCode = 'cash' | 'card_terminal' | 'provider';

export interface RefundOptionLine {
  id: number;
  kind: string;
  item_name: string;
  quantity: number;
  amount: string;
  refunded_amount: string;
  refundable_amount: string;
}

export interface RefundOptions {
  billing_event_id: number;
  collected_amount: string;
  refunded_amount: string;
  refundable_amount: string;
  refund_state: 'none' | 'partial' | 'full';
  methods: { code: RefundMethodCode; name: string }[];
  lines: RefundOptionLine[];
}

const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);
const euros = (c: number) => (c / 100).toFixed(2);

/** A line can be selected while it still has something to return. */
export function lineSelectable(l: RefundOptionLine): boolean {
  return cents(l.refundable_amount) > 0;
}

/** The sum of the selected lines' refundable amounts, as a 2-decimal string. */
export function selectedLinesTotal(lines: readonly RefundOptionLine[], selected: ReadonlySet<number>): string {
  return euros(lines.filter((l) => selected.has(l.id) && lineSelectable(l)).reduce((s, l) => s + cents(l.refundable_amount), 0));
}

/** An ad-hoc amount the UI accepts: positive, at most two decimals, within the refundable balance. */
export function adhocAmountError(raw: string, opts: RefundOptions): 'invalid' | 'zero' | 'exceeds' | null {
  const text = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return 'invalid';
  const c = cents(text);
  if (c <= 0) return 'zero';
  if (c > cents(opts.refundable_amount) || c > cents(opts.collected_amount)) return 'exceeds';
  return null;
}

/** The amount the confirmation will return, or null when the form is not complete. */
export function refundAmount(kind: RefundKind, opts: RefundOptions, selected: ReadonlySet<number>, adhoc: string): string | null {
  if (kind === 'full') return cents(opts.refundable_amount) > 0 ? euros(cents(opts.refundable_amount)) : null;
  if (kind === 'lines') {
    const total = selectedLinesTotal(opts.lines, selected);
    return cents(total) > 0 && cents(total) <= cents(opts.refundable_amount) ? total : null;
  }
  return adhocAmountError(adhoc, opts) ? null : euros(cents(adhoc.trim().replace(',', '.')));
}

export function canAcceptRefund(kind: RefundKind, opts: RefundOptions, selected: ReadonlySet<number>, adhoc: string, method: string, busy: boolean): boolean {
  if (busy || !opts.methods.some((m) => m.code === method)) return false;
  return refundAmount(kind, opts, selected, adhoc) != null;
}

/** The body of `POST /payments/billing-events/:id/refund`. */
export function refundRequestBody(kind: RefundKind, method: RefundMethodCode, selected: ReadonlySet<number>, adhoc: string): Record<string, unknown> {
  if (kind === 'lines') return { kind, method, line_ids: [...selected] };
  if (kind === 'adhoc') return { kind, method, amount: adhoc.trim().replace(',', '.') };
  return { kind, method };
}
