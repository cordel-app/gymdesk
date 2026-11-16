// #2885 — "a document was issued for this Billing Event". Generate Receipt and
// Generate Complete Invoice are the ⋮ menu's (`useBillingEventActions`), while
// the Receipts & Invoices table lives in the event's expanded row, which both
// hosts (Payments → Billing Events and the Member card's Payments tab) render
// and which never remounts when the list re-reads. This is the one signal
// between them: the action announces the event id after a successful issue,
// and the expanded row of that event re-reads its details and documents. A
// failed issue announces nothing, so no row appears.
import { useEffect, useRef } from 'react';

export const BILLING_EVENT_DOCUMENTS_CHANGED = 'billing-event-documents-changed';

/** Announce that a receipt or invoice was issued for `billingEventId`. */
export function notifyBillingEventDocumentsChanged(billingEventId: number, target: EventTarget | null = typeof window === 'undefined' ? null : window): void {
  target?.dispatchEvent(new CustomEvent(BILLING_EVENT_DOCUMENTS_CHANGED, { detail: { billingEventId } }));
}

/**
 * Subscribe to the signal for one Billing Event; `onChange` runs only for that
 * event's id. Returns the unsubscribe function.
 */
export function subscribeBillingEventDocumentsChanged(
  billingEventId: number,
  onChange: () => void,
  target: EventTarget | null = typeof window === 'undefined' ? null : window,
): () => void {
  if (!target) return () => {};
  const listener = (e: Event) => {
    if ((e as CustomEvent<{ billingEventId: number }>).detail?.billingEventId === billingEventId) onChange();
  };
  target.addEventListener(BILLING_EVENT_DOCUMENTS_CHANGED, listener);
  return () => target.removeEventListener(BILLING_EVENT_DOCUMENTS_CHANGED, listener);
}

/** React binding of `subscribeBillingEventDocumentsChanged`; the latest callback always runs. */
export function useBillingEventDocumentsChanged(billingEventId: number, onChange: () => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => subscribeBillingEventDocumentsChanged(billingEventId, () => ref.current()), [billingEventId]);
}
