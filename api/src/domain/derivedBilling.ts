/**
 * #1325 — the billing dates and dunning counts of an assignment, **derived** from
 * the Billing Events and payment attempts of the ProductSet that projects it.
 *
 * `user_memberships.next_billing_date`, `last_billed_at`, `failed_attempts` and
 * `last_failed_at` are legacy storage of facts the ledger already holds. The
 * decision on the ticket is that none of them is stored for a ProductSet: they
 * are read off its events and attempts. This module is the pure half — what the
 * rows mean — and `api/derived-billing.ts` is the SQL that supplies them.
 *
 *  - **next billing date**: the earliest obligation not yet settled — a
 *    scheduled event, or a failed one still awaiting its retry. A past due date
 *    is kept (it is the cycle still owed), exactly as the legacy column stayed
 *    on a rejected cycle.
 *  - **last billed at**: the latest completed, money-moving attempt (a provider
 *    success or a cash payment; never a waiver, which bills nothing).
 *  - **failed attempts**: the failed provider attempts of the **event being
 *    charged** — the latest unresolved failed one — counted by distinct UTC date,
 *    because #785's escalation is one step per run day, never per attempt.
 *  - **last failed at**: the latest of those attempts.
 */

export interface EventFact {
  id: number;
  /** `YYYY-MM-DD`. */
  billingDate: string | null;
  isScheduled: boolean;
  eventType: string;
}

export interface AttemptFact {
  billingEventId: number;
  method: 'provider' | 'cash' | 'waive';
  /** The internal outcome: `pending` / `completed` / `failed` / `expired`. */
  status: string;
  /** ISO datetime of the attempt's creation / completion. */
  createdAt: string;
  completedAt: string | null;
}

export interface DerivedBilling {
  next_billing_date: string | null;
  last_billed_at: string | null;
  failed_attempts: number;
  last_failed_at: string | null;
}

export function deriveBilling(events: readonly EventFact[], attempts: readonly AttemptFact[]): DerivedBilling {
  const settledEventIds = new Set(
    attempts.filter((a) => a.status === 'completed').map((a) => a.billingEventId),
  );

  // Next: scheduled, or failed-and-unsettled, earliest first.
  const open = events.filter((e) =>
    e.billingDate != null && !settledEventIds.has(e.id)
    && (e.isScheduled || e.eventType === 'failed_billing'));
  const next = open.map((e) => e.billingDate as string).sort()[0] ?? null;

  // Last billed: money actually moved.
  const billed = attempts
    .filter((a) => a.status === 'completed' && a.method !== 'waive')
    .map((a) => a.completedAt ?? a.createdAt)
    .sort();
  const lastBilled = billed.length > 0 ? billed[billed.length - 1] : null;

  // Dunning: the failed event being charged is the latest unresolved failed one.
  const failedEvents = events
    .filter((e) => e.eventType === 'failed_billing' && !settledEventIds.has(e.id))
    .sort((a, b) => ((a.billingDate ?? '') < (b.billingDate ?? '') ? 1 : -1));
  const target = failedEvents[0];
  let failedAttempts = 0;
  let lastFailed: string | null = null;
  if (target) {
    const failed = attempts.filter((a) => a.billingEventId === target.id && a.method === 'provider' && a.status === 'failed');
    failedAttempts = new Set(failed.map((a) => a.createdAt.slice(0, 10))).size;
    lastFailed = failed.map((a) => a.createdAt).sort().pop() ?? null;
  }

  return {
    next_billing_date: next,
    last_billed_at: lastBilled,
    failed_attempts: failedAttempts,
    last_failed_at: lastFailed,
  };
}
