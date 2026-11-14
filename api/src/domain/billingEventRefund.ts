/**
 * #2480 — what a Billing Event may still give back, and what one refund request
 * asks for. Pure: the SQL half is `api/src/api/billing-event-refunds.ts`, which
 * loads the rows this module reads and writes what it decides.
 *
 * Money is handled in cents throughout so a sum of lines and an ad-hoc amount
 * are compared exactly (`toCents`, `fromCents`).
 *
 * - **Collected** is the original payment attempt's amount (the completed
 *   `payment` transaction the refund returns money from).
 * - **Refunded** counts every refund that is completed **or still pending**: a
 *   pending one may yet complete at the provider, so its amount is reserved
 *   and can never be refunded a second time. A failed refund counts nothing.
 * - **Refundable** is collected − refunded, never below zero.
 * - A **line** is refundable by what it carries less what Selected Line Items
 *   refunds have already returned on it.
 */

export const REFUND_KINDS = ['full', 'lines', 'adhoc'] as const;
export type RefundKind = (typeof REFUND_KINDS)[number];

/**
 * How the money goes back. `cash` and `card_terminal` are recorded by hand;
 * `provider` calls MONEI. Since #2797 it is never chosen: a refund goes back
 * through the method of the payment it returns (`refundMethodFor()`).
 */
export const REFUND_METHODS = ['cash', 'card_terminal', 'provider'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

export const toCents = (v: number | string | null | undefined): number =>
  Math.round(Number(v ?? 0) * 100);
export const fromCents = (c: number): string => (c / 100).toFixed(2);

export interface RefundRow {
  amount: number | string;
  /** `payment_requests.status` of the refund transaction. */
  status: string;
}

/** Completed and pending refunds count; failed / expired ones never do. */
export function countsAsRefunded(status: string): boolean {
  return status === 'completed' || status === 'pending';
}

export function refundedCents(refunds: readonly RefundRow[]): number {
  return refunds.reduce((s, r) => (countsAsRefunded(r.status) ? s + toCents(r.amount) : s), 0);
}

export function completedRefundCents(refunds: readonly RefundRow[]): number {
  return refunds.reduce((s, r) => (r.status === 'completed' ? s + toCents(r.amount) : s), 0);
}

export interface LineState {
  id: number;
  amount: number | string;
  /** Cents already returned on this line by non-failed refunds. */
  refundedCents: number;
}

export function lineRemainingCents(l: LineState): number {
  return Math.max(0, toCents(l.amount) - l.refundedCents);
}

/** `none`, `partial` or `full`, from completed refunds against what was collected. */
export type RefundState = 'none' | 'partial' | 'full';
export function refundState(collectedCents: number, completedCents: number): RefundState {
  if (completedCents <= 0) return 'none';
  return completedCents >= collectedCents ? 'full' : 'partial';
}

export interface RefundBalance {
  collectedCents: number;
  refundedCents: number;
  refundableCents: number;
}

export function refundBalance(collectedCents: number, refunds: readonly RefundRow[]): RefundBalance {
  const refunded = refundedCents(refunds);
  return { collectedCents, refundedCents: refunded, refundableCents: Math.max(0, collectedCents - refunded) };
}

export interface RefundRequestInput {
  kind?: unknown;
  amount?: unknown;
  line_ids?: unknown;
  /** Optional and never a choice (#2797): when sent it must be the original payment's method. */
  method?: unknown;
}

export interface ParsedRefund {
  kind: RefundKind;
  method: RefundMethod;
  amountCents: number;
  /** Selected Line Items only: the cents taken from each line. */
  lines: { id: number; cents: number }[];
}

export type RefundDecision = { ok: true; refund: ParsedRefund } | { ok: false; error: string };

/**
 * Judges one refund request against the event's current balance and lines.
 * The caller takes it under the event's row lock, so the balance it is handed
 * already counts every other refund.
 */
export function decideRefund(
  input: RefundRequestInput,
  balance: RefundBalance,
  lines: readonly LineState[],
  originalMethod: RefundMethod,
): RefundDecision {
  const kind = String(input.kind ?? '') as RefundKind;
  if (!(REFUND_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: "kind must be 'full', 'lines' or 'adhoc'" };
  }
  // #2797: the method is the original payment's. A request need not name it;
  // one that names another is refused rather than silently overridden.
  const method = originalMethod;
  if (input.method != null && input.method !== '' && input.method !== originalMethod) {
    return { ok: false, error: 'A refund goes back through the original payment method; it cannot be changed.' };
  }
  if (balance.refundableCents <= 0) {
    return { ok: false, error: 'Nothing is left to refund on this billing event.' };
  }

  if (kind === 'full') {
    return { ok: true, refund: { kind, method, amountCents: balance.refundableCents, lines: [] } };
  }

  if (kind === 'adhoc') {
    const raw = input.amount;
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (!/^\d+(\.\d{1,2})?$/.test(text)) {
      return { ok: false, error: 'amount must be a positive number with at most two decimals' };
    }
    const cents = toCents(text);
    if (cents <= 0) return { ok: false, error: 'amount must be greater than 0' };
    if (cents > balance.collectedCents) return { ok: false, error: 'amount exceeds the amount collected' };
    if (cents > balance.refundableCents) return { ok: false, error: 'amount exceeds the remaining refundable balance' };
    return { ok: true, refund: { kind, method, amountCents: cents, lines: [] } };
  }

  // Selected Line Items
  if (!Array.isArray(input.line_ids) || input.line_ids.length === 0) {
    return { ok: false, error: 'Select at least one line to refund.' };
  }
  const ids = [...new Set(input.line_ids.map((v) => Number(v)))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return { ok: false, error: 'line_ids must be line ids' };
  const byId = new Map(lines.map((l) => [l.id, l]));
  const picked: { id: number; cents: number }[] = [];
  for (const id of ids) {
    const line = byId.get(id);
    if (!line) return { ok: false, error: `Line ${id} does not belong to this billing event.` };
    const cents = lineRemainingCents(line);
    if (cents <= 0) return { ok: false, error: `Line ${id} has already been refunded.` };
    picked.push({ id, cents });
  }
  const total = picked.reduce((s, p) => s + p.cents, 0);
  if (total > balance.refundableCents) {
    return { ok: false, error: 'The selected lines exceed the remaining refundable balance.' };
  }
  return { ok: true, refund: { kind, method, amountCents: total, lines: picked } };
}

/**
 * #2797 — the one method a collected payment is refunded through: its own.
 * A cash or card-terminal payment is returned by hand and recorded; a payment
 * taken through the provider is refunded by the provider on that same payment.
 * `null` when it cannot be determined: a provider payment that carries no
 * provider reference has no transaction to refund, and it is not handed back
 * through another method instead.
 */
export function refundMethodFor(original: { method: string | null; providerRef: string | null }): RefundMethod | null {
  if (original.method === 'provider') return original.providerRef ? 'provider' : null;
  if (original.method === 'cash' || original.method === 'card_terminal') return original.method;
  return null;
}

/** A manual refund calls no provider: the gym returns the money itself. */
export function isManualRefundMethod(method: RefundMethod): boolean {
  return method !== 'provider';
}

/** Classifies MONEI's answer to a refund call. Anything not refunded is not a completed refund. */
export function refundOutcomeFromProvider(status: string | null | undefined): 'completed' | 'pending' | 'failed' {
  const s = String(status ?? '').toUpperCase();
  if (s === 'REFUNDED' || s === 'PARTIALLY_REFUNDED') return 'completed';
  if (s === 'PENDING' || s === 'PENDING_PROCESSING' || s === 'AUTHORIZED') return 'pending';
  return 'failed';
}
