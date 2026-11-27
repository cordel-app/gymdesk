import { SYSTEM_ACTOR } from '../domain/auditActor';
import { Router, Request, Response } from 'express';
import { db } from '../infra/db';
import { abandonedRequestHours } from '../domain/paymentRequestExpiry';
import { cancelAbandonedPurchases } from './me-products';
import { expireCarts } from './cart-expiry';
import { ClaimResult, RunLogTable, claimRun, finishRun } from '../infra/run-log';
import { finishJobRun, startJobRun } from '../infra/job-run-log';
import { buildJobMetrics } from '../domain/jobRuns';
import { executeDueScheduledEvents } from './scheduled-event-execution';
import { issueDueSimplifiedInvoices } from './billing-invoices';
import { paidDocumentsSince, reconcilePaidEventDocuments } from './paid-event-documents';
import { expirePendingPayments } from './product-set-cancellation';
import { reconcileAbandonedRequests } from './payment-settlement';
import { reconcilePendingProviderRefunds } from './billing-event-refunds';
import { maintainBillingWindow } from './billing-window-maintenance';

// The date arithmetic itself lives in `domain/billingDate.ts` since #635
// stage 11 (see that module for why), and is re-exported here so every caller
// that has always imported it from the router keeps working.
export { advanceBillingDate } from '../domain/billingDate';

export const billingRouter = Router();

/** #780: the history this run claims a row in. */
const BILLING_RUN_LOG: RunLogTable = 'billing_run_log';

function checkInternalSecret(req: Request, res: Response): boolean {
  const secret = req.headers['x-internal-secret'];
  const expected = process.env.BILLING_INTERNAL_SECRET;
  if (!expected || secret !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * POST /billing/run
 * Nightly MIT billing run: executes every ProductSet Billing Event that is due
 * (`executeDueScheduledEvents`, #1325) — a persisted obligation with its own
 * amount, its own due date and its own attempts, charged against the member's
 * stored card. Nothing here prices a cycle: the amount was persisted by the
 * engine when the version was committed, and an edit replaces the event before
 * it is due.
 *
 * Auth: X-Internal-Secret header (BILLING_INTERNAL_SECRET env var).
 *
 * #785 — a rejected charge escalates, it does not repeat: one attempt per UTC
 * day on the same event, and the second failed day pauses the assignment the
 * ProductSet projects (`recordStatusChange`, `active → paused`, `source =
 * 'system'`). Only a provider rejection counts — an unknown outcome and a
 * missing card do not (`scheduled-event-execution.ts`).
 *
 * #780 — the run guard is a calendar rule, not a rolling window:
 *   - a run that already **completed** today (UTC) answers
 *     `200 { skipped_reason: 'already_completed_today', run_date, …zeroed counters }`,
 *     so the second daily attempt (#781) is a green no-op rather than an alert;
 *   - a run that started less than `STALE_RUN_MINUTES` ago and has not finished
 *     answers `429` — that one really is "try later";
 *   - a run that started today and crashed blocks nothing: its row is closed as
 *     `failed`, and the next attempt is the day's real run.
 */
billingRouter.post('/run', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let waived = 0;
  // #785: how many assignments this run escalated to `paused` after a second
  // failed day. Reported beside the other counters (the workflow reads the four
  // named ones by name, so an extra field is additive) but deliberately *not*
  // written to `billing_run_log`: the pause is an audit row, which is where it
  // is explicable from.
  let paused = 0;
  // #787: how many settled charges got a receipt number allocated in this run.
  // Reported for visibility only — it is not a run-log column either, because
  // a receipt that failed to auto-issue is not a failed run (it stays issuable
  // on demand), and the workflow must not turn one red because of it.
  let receiptsIssued = 0;

  // #780: one **completed** run per UTC date, not "23 hours since the last
  // start". The claim is taken before the try/catch's work so that a crash
  // below can close the row as `failed` — which is what stops a half-finished
  // run from locking the rest of the day.
  let claim: ClaimResult;
  try {
    claim = await claimRun(BILLING_RUN_LOG);
  } catch (err) {
    req.log.error({ err: (err as Error).message }, 'billing/run: could not claim the run log');
    return res.status(500).json({ error: 'Internal server error' });
  }
  if (!claim.claimed) {
    if (claim.reason === 'already_completed_today') {
      // Deliberately 200, not 429: from #781 a second schedule hits this every
      // day the first one worked, and the honest answer is "the work is done",
      // not "retry later". The zeroed counters keep the workflow's body parse
      // (#778) working unchanged, and `skipped_reason` is what tells it apart
      // from a night when nothing was due. It is not called `skipped` because
      // the recurring booking run already reports a numeric `skipped` counter
      // and the two must not collide in one contract.
      req.log.info({ runDate: claim.runDate }, 'billing/run: already completed today');
      return res.json({
        skipped_reason: 'already_completed_today',
        run_date: claim.runDate,
        processed: 0, succeeded: 0, failed: 0, waived: 0, paused: 0,
        receipts_issued: 0,
      });
    }
    req.log.warn({ startedAt: claim.startedAt }, 'billing/run: another run is in progress');
    return res.status(429).json({
      error: 'A billing run is already in progress',
      started_at: claim.startedAt,
    });
  }

  try {
    // #788: until migration 195 the NOT NULL on `payment_requests.charge_type_id`
    // was what turned a missing global `membership_fee` charge type into a loud
    // failure here. That column is nullable now — a NULL charge type is how a
    // card verification says "this row is not a charge" — so the run would
    // otherwise write real money charges carrying that same marker. Fail before
    // charging anyone, as the retry and manual-payment paths already do
    // (`domain/billingEventPayments.ts`); a `charge_types` row missing from a
    // seeded global lookup means a broken install, not a night to work through.
    const { rows: ctRows } = await db.query<{ id: number }>(
      "SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1",
    );
    if (ctRows[0]?.id == null) {
      await finishRun(BILLING_RUN_LOG, claim.runId, 'failed', { processed: 0, succeeded: 0, failed: 0, waived: 0 })
        .catch((logErr) => req.log.error({ err: (logErr as Error).message }, 'billing/run: could not close run log'));
      req.log.error('billing/run: charge_type membership_fee is not configured');
      return res.status(500).json({ error: 'charge_type membership_fee not configured' });
    }

    // #1325 PR 3: the run is the execution of the ProductSets' persisted Billing
    // Events and nothing else. The assignment pass that priced the cycle
    // `next_billing_date` named is gone: every committed assignment is a
    // ProductSet version whose obligations are already in the ledger, so there
    // is no second schedule to walk. The counters keep their names and meaning
    // because `.github/workflows/billing-run.yml` parses them (#778), and
    // `paused` is #785's escalation moved onto the event's own failed days.
    const today = new Date().toISOString().slice(0, 10);
    const s = await executeDueScheduledEvents({ today, log: req.log });
    processed = s.processed;
    succeeded = s.succeeded;
    failed = s.failed;
    waived = s.waived;
    paused = s.paused;
    receiptsIssued = s.receiptsIssued;
    const scheduledEvents: Record<string, number> = { ...s };
    // #2648 stage 6: after the charges, every scheduled obligation whose billing
    // date has come gets its simplified invoice, paid or not. Never fails the run.
    let invoices = { issued: 0, failed: 0 };
    try {
      invoices = await issueDueSimplifiedInvoices({ today, log: req.log });
    } catch (err) {
      req.log.error({ err: (err as Error).message }, 'billing/run: automatic invoicing failed');
    }
    // #3511: every event paid in the last days that still lacks its receipt
    // number or its paid simplified invoice (a path that missed it, a failure
    // after the payment) gets them now. Idempotent; never fails the run.
    let paidDocuments = { candidates: 0, receipts: 0, representations: 0, failed: 0 };
    try {
      const r = await reconcilePaidEventDocuments({ since: paidDocumentsSince(today), log: req.log });
      paidDocuments = { candidates: r.candidates, receipts: r.receipts, representations: r.representations, failed: r.failed };
    } catch (err) {
      req.log.error({ err: (err as Error).message }, 'billing/run: paid document reconciliation failed');
    }

    await finishRun(BILLING_RUN_LOG, claim.runId, 'completed', { processed, succeeded, failed, waived });

    req.log.info(
      { processed, succeeded, failed, waived, paused, receiptsIssued, invoices, paidDocuments, scheduledEvents },
      'billing/run: complete',
    );
    res.json({
      processed, succeeded, failed, waived, paused,
      receipts_issued: receiptsIssued,
      invoices_issued: invoices.issued,
      invoices_failed: invoices.failed,
      paid_documents: paidDocuments,
      scheduled_events: scheduledEvents,
    });
  } catch (err) {
    // Close the run as `failed` with whatever it got through. Without this the
    // row would stay `in_progress` until STALE_RUN_MINUTES retires it, and the
    // freshness alert (#782) would read a run that never ended.
    await finishRun(BILLING_RUN_LOG, claim.runId, 'failed', { processed, succeeded, failed, waived })
      .catch((logErr) => req.log.error({ err: (logErr as Error).message }, 'billing/run: could not close run log'));

    req.log.error({ err: (err as Error).message }, 'billing/run: unexpected error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /billing/cleanup
 * Expires stale pending payment_requests.
 * Auth: X-Internal-Secret header (BILLING_INTERNAL_SECRET env var).
 *
 * #789: this used to expire every `pending` row past its ten-minute
 * `page_token_expires`, which is the deadline for *opening* the checkout link,
 * not for paying through it. `GET /payment-page/token/:token` consumes the token
 * as the page loads (`page_token = NULL`), and the member then spends minutes in
 * the Card Input and a 3DS redirect; Monei may retry its webhook later still.
 * A row expired inside that window was skipped by the webhook's
 * `pr.status !== 'pending'` guard, so a member who had actually been charged
 * ended up with no completed request, no stored card and no `next_billing_date`.
 *
 * Two deadlines, therefore — see `domain/paymentRequestExpiry.ts`:
 *
 *  - **Never opened** (`page_token IS NOT NULL` — the single writer that clears
 *    it is the page load): expires with the token, as before. No page was
 *    opened, so no payment can be in flight.
 *  - **Opened** (`page_token IS NULL` on a row still `pending`): kept for the
 *    long window below, counted from the token's own TTL, so a terminal webhook
 *    can still land on it. Past that the provider never resolved it and the row
 *    is written off.
 *    Since #2087 the provider is asked first (`reconcileAbandonedRequests()`):
 *    a request it reports as paid is settled instead, and only one it still
 *    reports with no outcome is written off.
 *
 * `expired` stays the total, because `.github/workflows/billing-run.yml` parses
 * that field (#778); the two components are reported beside it.
 */
billingRouter.post('/cleanup', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  const jobRunId = await startJobRun('billing_cleanup');
  try {
    const { rowCount: unopened } = await db.query(
      `UPDATE payment_requests
       SET status = 'expired', page_token = NULL,
           modified_at = UTC_TIMESTAMP(), modified_by = ?
       WHERE status = 'pending'
         AND page_token IS NOT NULL
         AND page_token_expires < UTC_TIMESTAMP()`,
      [SYSTEM_ACTOR],
    );

    // The grace period is added in SQL so the comparison stays in the database's
    // UTC clock, the same one `page_token_expires` was written against.
    const hours = abandonedRequestHours();
    // #2087: the provider is asked first. A request it reports as settled is
    // settled from its answer instead of being written off; one it still
    // reports pending is in `writeOff` and expires below as before; one it
    // could not be asked about stays pending for the next run. A request with
    // no provider payment id has nothing to ask and expires as before.
    const { reconciled, writeOff } = await reconcileAbandonedRequests(hours, req.log);
    const writeOffClause = writeOff.length > 0
      ? `(provider_ref IS NULL OR id IN (${writeOff.map(() => '?').join(',')}))`
      : 'provider_ref IS NULL';
    const { rowCount: abandoned } = await db.query(
      `UPDATE payment_requests
       SET status = 'expired', modified_at = UTC_TIMESTAMP(), modified_by = ?
       WHERE status = 'pending'
         AND page_token IS NULL
         AND page_token_expires < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
         AND ${writeOffClause}`,
      [SYSTEM_ACTOR, hours, ...writeOff],
    );

    // #1121 stage 2: a product purchase whose payment is over has to stop being
    // `pending_payment`, or its UNIQUE pending key blocks the member from ever
    // buying that Product again. Keyed on the request's status — including the
    // rows just expired above — so there is no second definition of when an
    // attempt is finished, and it is reported beside the totals rather than
    // folded into `expired`, which `.github/workflows/billing-run.yml` parses.
    const purchasesCancelled = await cancelAbandonedPurchases();

    // #3274: a cart (purchase) past its two hours is expired as a whole — its Product Set Draft and
    // its one-time lines together — re-checked under its locks, so one changed or paid in between
    // survives. Reported beside the totals (Draft sets and one-time lines, as before, plus carts),
    // never folded into `expired`.
    const cartsExpired = await expireCarts();
    const draftsExpired = cartsExpired.productSets;
    const purchaseDraftsExpired = cartsExpired.lines.length;
    // #3307 stage 3: a Pending Payment not paid within 24 hours expires (replacing #1991's
    // two-hour return to Draft), its initial Billing Event reading *24h expired*.
    const pendingExpired = await expirePendingPayments(req.log);
    // #2480 follow-up: a provider refund left pending is settled from the provider's own record.
    const refunds = await reconcilePendingProviderRefunds(req.log);

    const expired = unopened + abandoned;
    req.log.info(
      { expired, unopened, abandoned, reconciled, abandonedAfterHours: hours, purchasesCancelled },
      'payment_requests cleanup: expired rows',
    );
    const cleanupBody = {
      expired,
      expired_unopened: unopened,
      expired_abandoned: abandoned,
      // #2087: opened requests the provider's answer settled instead of being expired.
      reconciled,
      purchases_cancelled: purchasesCancelled,
      carts_expired: cartsExpired.carts,
      drafts_expired: draftsExpired,
      purchase_drafts_expired: purchaseDraftsExpired,
      pending_payments_expired: pendingExpired,
      refunds_completed: refunds.completed,
      refunds_failed: refunds.failed,
    };
    // #3009: every step selects the records it changes (its own WHERE or lookup), so the
    // records it reports are the ones it considered; a refund the provider did not confirm
    // was considered and left pending, which is not counted anywhere.
    const metrics = buildJobMetrics(
      expired + reconciled + purchasesCancelled + draftsExpired + purchaseDraftsExpired
        + pendingExpired + refunds.completed + refunds.failed,
    );
    await finishJobRun(jobRunId, 'completed', { httpStatus: 200, details: { ...cleanupBody, metrics } });
    res.json(cleanupBody);
  } catch (err) {
    await finishJobRun(jobRunId, 'failed', { httpStatus: 500, error: err });
    req.log.error({ err: (err as Error).message }, 'billing cleanup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /billing/maintain-window
 * #3445 — replenishes the rolling window of future Scheduled Billing Events: for every Active
 * Product Set, the next two distinct positive billing dates across all its schedules are persisted
 * (stage 2: one event per date, consolidating every schedule that owes on it)
 * (`maintainBillingWindow()` over `materialiseScheduledEvents()`). Executes no charge and creates
 * no payment attempt.
 * Auth: X-Internal-Secret header (BILLING_INTERNAL_SECRET env var).
 *
 * No run-log slot: every set is idempotent (an obligation already persisted for its
 * `(schedule, period)` is left alone), so a repeated or overlapping call creates nothing twice.
 * A set that failed is counted in `failures` and answers `500` once the rest are done, so the
 * caller sees an incomplete run and can retry it. #3444: `product_sets` reports each set's target
 * status (`at_target`, `replenished`, `shortfall`, `incomplete`, `failed`), and an `incomplete`
 * set answers `500` too.
 */
billingRouter.post('/maintain-window', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  const jobRunId = await startJobRun('billing_window_maintenance');
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await maintainBillingWindow(today, req.log);
    const body = { run_date: today, ...result };
    const metrics = buildJobMetrics(result.product_sets_updated, result.product_sets_examined - result.product_sets_updated);
    // #3444: a set left below its planned window is an incomplete run too; a legitimate
    // shortfall (the contract owes fewer future obligations) is not.
    const failed = result.failures > 0 || result.product_sets_incomplete > 0;
    // The full per-set list is the response's; the run log and the log line keep the sets that
    // did not reach the target, so a large gym does not write one row per healthy set.
    const { product_sets: sets, ...counters } = body;
    const belowTarget = sets.filter((s) => s.status !== 'at_target' && s.status !== 'replenished');
    await finishJobRun(jobRunId, failed ? 'failed' : 'completed', {
      httpStatus: failed ? 500 : 200, details: { ...counters, product_sets_below_target: belowTarget, metrics },
    });
    req.log.info({ ...counters, product_sets_below_target: belowTarget }, 'billing/maintain-window: done');
    res.status(failed ? 500 : 200).json(body);
  } catch (err) {
    await finishJobRun(jobRunId, 'failed', { httpStatus: 500, error: err });
    req.log.error({ err: (err as Error).message }, 'billing/maintain-window failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
