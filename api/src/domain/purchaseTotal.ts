/**
 * #3355 stage 2 — a purchase's **Total Amount**, as the Member card's Purchases table shows it.
 *
 * A purchase's money is its Billing Events (stamped with its `purchase_id`, #3251); nothing here
 * prices anything. The total is the sum of the events that are not cancelled, because a member's
 * cancelled checkout keeps its event in history and the next Save & Pay writes a new one (#3309):
 * counting both would charge the purchase twice on screen. A purchase whose every event is
 * cancelled reads its latest event's amount, so a cancelled purchase still says what it was for.
 * No event (a cart not yet checked out) is `null`, which reads as `—`, never €0.00.
 */
export interface PurchaseTotalEvent {
  id: number;
  amount: string | number | null;
  cancelled: boolean;
}

const cents = (v: string | number | null): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

export function purchaseTotalAmount(events: readonly PurchaseTotalEvent[]): string | null {
  const priced = events.filter((e) => cents(e.amount) != null);
  if (priced.length === 0) return null;
  const live = priced.filter((e) => !e.cancelled);
  if (live.length > 0) {
    const sum = live.reduce((acc, e) => acc + (cents(e.amount) as number), 0);
    return (sum / 100).toFixed(2);
  }
  const latest = priced.reduce((a, b) => (b.id > a.id ? b : a));
  return ((cents(latest.amount) as number) / 100).toFixed(2);
}
