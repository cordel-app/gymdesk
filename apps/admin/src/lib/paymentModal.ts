// #3498 — the one shared payment modal's pure half. Save & Pay (Review your
// changes) and a Billing Event's Pay now draw the same modal: the title on the
// left, the amount being collected large at the top right, the items being paid
// listed underneath. This module decides only how that amount and those items
// read; it prices nothing — the amount is the server's (the review's
// `amount_due`, the event's `amount`) and every item amount is a persisted or
// server-computed figure.

import { formatGymAmount, type GymFormatSettings } from './gymFormat';

/** One item the modal lists: a name, how many, and the server's amount. */
export interface PaymentModalItem {
  key: string;
  name: string | null;
  quantity: number;
  amount: number;
}

/**
 * The headline amount. Zero reads `0 €` (never blank, never "Nothing is due"),
 * an unknown amount (still loading, or unreadable) reads `—`.
 */
export function paymentModalAmountLabel(amount: number | string | null | undefined, settings?: GymFormatSettings): string {
  if (amount == null || amount === '') return '—';
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return `0 ${(settings?.currency ?? 'EUR') === 'EUR' ? '€' : settings?.currency}`;
  return formatGymAmount(n, settings);
}

/** An item's label: its name, with the quantity appended only above one. */
export function paymentItemLabel(item: Pick<PaymentModalItem, 'name' | 'quantity'>): string {
  const name = item.name ?? '—';
  return item.quantity > 1 ? `${name} × ${item.quantity}` : name;
}

/** The Billing Event's persisted lines (`GET …/pay-now`'s `lines`), in their stored order. */
export function billingEventPaymentItems(
  lines: Array<{ id: number; item_name: string | null; quantity: number | string | null; amount: number | string | null }> | null | undefined,
): PaymentModalItem[] {
  return (lines ?? []).map((l) => ({
    key: String(l.id),
    name: l.item_name ?? null,
    quantity: Number(l.quantity ?? 1) || 1,
    amount: Number(l.amount ?? 0),
  }));
}

/**
 * Whether what is about to be confirmed is still what the modal showed: the
 * amount and the items, compared in cents. A stale modal is never confirmed.
 */
export function paymentModalUnchanged(
  shown: { amount: number | string | null; items: PaymentModalItem[] },
  fresh: { amount: number | string | null; items: PaymentModalItem[] },
): boolean {
  const cents = (v: number | string | null) => (v == null ? null : Math.round(Number(v) * 100));
  if (cents(shown.amount) !== cents(fresh.amount)) return false;
  if (shown.items.length !== fresh.items.length) return false;
  return shown.items.every((it, i) => {
    const f = fresh.items[i];
    return it.name === f.name && it.quantity === f.quantity && cents(it.amount) === cents(f.amount);
  });
}
