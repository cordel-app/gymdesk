// #3511 — the documents a paid Billing Event is owed: its receipt number and its
// simplified invoice with the paid representation. One entry point for every
// payment completion path (provider settlement, cash, card terminal, Pay now,
// Save & Pay) and for the nightly reconciliation that catches whatever a path
// missed or failed. Idempotent: the receipt number is allocated under the event
// row lock (`issueReceiptNumber()`) and the invoice writer finds an existing
// invoice before issuing. A failure never touches the payment: it is logged
// with the event id and the next reconciliation retries it.
import { db } from '../infra/db';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { issueReceiptNumber } from '../domain/receiptNumbers';
import { RECEIPTABLE_EVENT_TYPES } from '../domain/billingEventStatus';
import {
  PAID_DOCUMENTS_BATCH_SIZE, PAID_DOCUMENTS_CATCH_UP_DAYS, receiptOwed,
} from '../domain/paidEventDocuments';
import { generatePaidRepresentations } from './billing-invoices';
import { isPrivateStorageConfigured } from '../infra/private-storage';

type Log = { warn: (o: object, m: string) => void; error?: (o: object, m: string) => void };

export interface PaidDocumentsOutcome {
  receiptIssued: boolean;
  representations: number;
  failed: boolean;
}

async function issueOwedReceipt(gymId: string, eventId: number): Promise<boolean> {
  const { rows } = await db.query<any>(
    `SELECT be.event_type, be.amount, be.cancelled_at, be.receipt_number,
            (SELECT pr.status FROM payment_requests pr WHERE pr.billing_event_id = be.id
              ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1) AS latest_tx_status
       FROM billing_events be WHERE be.id = ? AND be.gym_id = ?`,
    [eventId, gymId]);
  const ev = rows[0];
  if (!ev || !receiptOwed({
    eventType: ev.event_type, latestTransactionStatus: ev.latest_tx_status,
    amount: parseFloat(ev.amount), cancelled: ev.cancelled_at != null, hasReceipt: !!ev.receipt_number,
  })) return false;
  const issued = await db.transaction((tx) => issueReceiptNumber(tx, gymId, eventId, SYSTEM_ACTOR));
  return issued.allocated;
}

/** Gives a paid event the documents it is owed. Never throws. */
export async function ensurePaidEventDocuments(
  gymId: string, eventId: number, log?: Log,
): Promise<PaidDocumentsOutcome> {
  const out: PaidDocumentsOutcome = { receiptIssued: false, representations: 0, failed: false };
  try {
    out.receiptIssued = await issueOwedReceipt(gymId, eventId);
  } catch (err) {
    out.failed = true;
    log?.warn({ billingEventId: eventId, err: String((err as any)?.message ?? err) },
      'paid event documents: receipt number allocation failed (payment stands, reconciliation retries)');
  }
  try {
    out.representations = await generatePaidRepresentations(gymId, eventId);
  } catch (err) {
    out.failed = true;
    log?.warn({ billingEventId: eventId, err: String((err as any)?.message ?? err) },
      'paid event documents: simplified invoice failed (payment stands, reconciliation retries)');
  }
  return out;
}

/** The fire-and-forget form a route uses after it has answered: logged, never swallowed. */
export function ensurePaidEventDocumentsLater(gymId: string, eventId: number, log?: Log): void {
  void ensurePaidEventDocuments(gymId, eventId, log);
}

function fromDate(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * The reconciliation: every event paid since `since` (by its completed
 * attempt's `completed_at`) that lacks its receipt number or, with the private
 * bucket configured, its issued invoice or that invoice's paid representation.
 * `since: null` reads the whole history (the backfill script). One event's
 * failure is counted and logged, never fails the pass.
 */
export async function reconcilePaidEventDocuments(opts: {
  since: string | null; log: Log; limit?: number; dryRun?: boolean;
}): Promise<{ candidates: number; receipts: number; representations: number; failed: number; eventIds: number[] }> {
  const marks = RECEIPTABLE_EVENT_TYPES.map(() => '?').join(', ');
  const invoiceGap = isPrivateStorageConfigured()
    ? ` OR NOT EXISTS (SELECT 1 FROM invoices i WHERE i.billing_event_id = be.id AND i.gym_id = be.gym_id
                         AND i.related_invoice_id IS NULL AND i.status = 'issued'
                         AND (i.simplified_paid_pdf_key IS NOT NULL OR i.full_paid_pdf_key IS NOT NULL
                              OR EXISTS (SELECT 1 FROM invoices f WHERE f.gym_id = i.gym_id AND f.replaces_invoice_id = i.id)))`
    : '';
  const limit = Math.max(1, Math.min(10000, Math.trunc(opts.limit ?? PAID_DOCUMENTS_BATCH_SIZE)));
  const { rows } = await db.query<{ id: number; gym_id: string }>(
    `SELECT be.id, be.gym_id FROM billing_events be
      WHERE be.cancelled_at IS NULL AND be.amount > 0
        AND be.event_type IN (${marks})
        AND EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.billing_event_id = be.id AND pr.status = 'completed'
                      ${opts.since ? 'AND pr.completed_at >= ?' : ''})
        AND (be.receipt_number IS NULL${invoiceGap})
      ORDER BY be.id ASC
      LIMIT ${limit}`,
    [...RECEIPTABLE_EVENT_TYPES, ...(opts.since ? [opts.since] : [])]);
  const result = { candidates: rows.length, receipts: 0, representations: 0, failed: 0, eventIds: rows.map((r) => Number(r.id)) };
  if (opts.dryRun) return result;
  for (const r of rows) {
    const o = await ensurePaidEventDocuments(r.gym_id, Number(r.id), opts.log);
    if (o.receiptIssued) result.receipts++;
    result.representations += o.representations;
    if (o.failed) result.failed++;
  }
  return result;
}

export function paidDocumentsSince(today: string): string {
  return fromDate(today, PAID_DOCUMENTS_CATCH_UP_DAYS);
}
