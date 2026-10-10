import { db } from '../infra/db';
import { AttemptFact, DerivedBilling, EventFact, deriveBilling } from '../domain/derivedBilling';

/**
 * #1325 — reads the derived billing values of assignments.
 *
 * For an assignment an **Active ProductSet projects** (`product_sets.
 * user_membership_id`) the four values come from the chain's Billing Events and
 * attempts (`domain/derivedBilling.ts`); for any other assignment they are the
 * row's own legacy columns, untouched. So a reader switches to
 * `withDerivedBilling()` once and is right for both, and when the legacy columns
 * are dropped the fallback goes with them.
 */

export interface LegacyBilling {
  id: number;
  next_billing_date?: unknown;
  last_billed_at?: unknown;
  failed_attempts?: unknown;
  last_failed_at?: unknown;
}

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  return (v instanceof Date ? v.toISOString() : String(v));
};

export async function loadDerivedBilling(gymId: string, assignmentIds: number[]): Promise<Map<number, DerivedBilling>> {
  const out = new Map<number, DerivedBilling>();
  const ids = [...new Set(assignmentIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return out;

  const { rows: sets } = await db.query<{ user_membership_id: number; root_product_set_id: number }>(
    `SELECT user_membership_id, root_product_set_id FROM product_sets
      WHERE gym_id = ? AND status = 'active' AND user_membership_id IN (${ids.map(() => '?').join(',')})`,
    [gymId, ...ids]);
  if (sets.length === 0) return out;

  const rootToUm = new Map<number, number>(sets.map((s) => [Number(s.root_product_set_id), Number(s.user_membership_id)]));
  const roots = [...rootToUm.keys()];
  const { rows: events } = await db.query<any>(
    `SELECT be.id, be.billing_date, be.is_scheduled, be.event_type, ps.root_product_set_id AS root
       FROM billing_events be JOIN product_sets ps ON ps.id = be.product_set_id
      WHERE be.gym_id = ? AND ps.root_product_set_id IN (${roots.map(() => '?').join(',')})`,
    [gymId, ...roots]);
  const eventIds = events.map((e: any) => Number(e.id));
  const attempts: any[] = eventIds.length === 0 ? [] : (await db.query<any>(
    `SELECT billing_event_id, method, status, created_at, completed_at
       FROM payment_requests WHERE gym_id = ? AND billing_event_id IN (${eventIds.map(() => '?').join(',')})`,
    [gymId, ...eventIds])).rows;

  const eventsByRoot = new Map<number, EventFact[]>();
  const rootOfEvent = new Map<number, number>();
  for (const e of events) {
    const root = Number(e.root);
    rootOfEvent.set(Number(e.id), root);
    const list = eventsByRoot.get(root) ?? [];
    list.push({
      id: Number(e.id), billingDate: iso(e.billing_date)?.slice(0, 10) ?? null,
      isScheduled: Number(e.is_scheduled) === 1, eventType: String(e.event_type),
    });
    eventsByRoot.set(root, list);
  }
  const attemptsByRoot = new Map<number, AttemptFact[]>();
  for (const a of attempts) {
    const root = rootOfEvent.get(Number(a.billing_event_id));
    if (root == null) continue;
    const list = attemptsByRoot.get(root) ?? [];
    list.push({
      billingEventId: Number(a.billing_event_id), method: (a.method ?? 'provider') as AttemptFact['method'],
      status: String(a.status), createdAt: iso(a.created_at) as string, completedAt: iso(a.completed_at),
    });
    attemptsByRoot.set(root, list);
  }

  for (const [root, umId] of rootToUm) {
    out.set(umId, deriveBilling(eventsByRoot.get(root) ?? [], attemptsByRoot.get(root) ?? []));
  }
  return out;
}

/** The rows with the four values replaced by the derived ones where a ProductSet owns the billing. */
export async function withDerivedBilling<T extends LegacyBilling>(gymId: string, rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;
  const derived = await loadDerivedBilling(gymId, rows.map((r) => Number(r.id)));
  // #1325 PR 3c: the columns are gone, so a row no set projects (a Draft, a
  // pending one) reports the four values as empty rather than undefined.
  const none: DerivedBilling = { next_billing_date: null, last_billed_at: null, failed_attempts: 0, last_failed_at: null };
  return rows.map((r) => ({ ...r, ...none, ...(derived.get(Number(r.id)) ?? {}) }));
}
