import { isReceiptableEvent } from './billingEventStatus';

/**
 * #3511 — which documents the system owes a Billing Event whose payment was
 * collected. Pure: the I/O half is `api/paid-event-documents.ts`.
 *
 * A receipt number is owed by every receiptable event (`isReceiptableEvent()`,
 * #787's one rule) with a positive amount that has none yet; the simplified
 * invoice is `shouldAutoIssueSimplified()`'s question and stays there. A
 * cancelled event is owed nothing automatically: its collected money stays
 * receiptable on demand (#2480), never by the system.
 */
export interface PaidEventFacts {
  eventType: string;
  latestTransactionStatus: string | null | undefined;
  amount: number;
  cancelled: boolean;
  hasReceipt: boolean;
}

export function receiptOwed(e: PaidEventFacts): boolean {
  if (e.cancelled || e.hasReceipt) return false;
  if (!(e.amount > 0)) return false;
  return isReceiptableEvent(e.eventType, e.latestTransactionStatus);
}

/** How far back the nightly reconciliation looks for a paid event missing its documents. */
export const PAID_DOCUMENTS_CATCH_UP_DAYS = 7;
/** At most this many events reconciled per pass. */
export const PAID_DOCUMENTS_BATCH_SIZE = 500;
