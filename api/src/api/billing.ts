import { Router, Request, Response } from 'express';
import { db } from '../infra/db';
import { abandonedRequestHours } from '../domain/paymentRequestExpiry';
import { cancelAbandonedPurchases } from './me-products';
import { ClaimResult, RunLogTable, claimRun, finishRun } from '../infra/run-log';
import { executeDueScheduledEvents } from './scheduled-event-execution';
import { expireDrafts } from './product-sets';

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

    await finishRun(BILLING_RUN_LOG, claim.runId, 'completed', { processed, succeeded, failed, waived });

    req.log.info(
      { processed, succeeded, failed, waived, paused, receiptsIssued, scheduledEvents },
      'billing/run: complete',
    );
    res.json({
      processed, succeeded, failed, waived, paused,
      receipts_issued: receiptsIssued,
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
 *
 * `expired` stays the total, because `.github/workflows/billing-run.yml` parses
 * that field (#778); the two components are reported beside it.
 */
billingRouter.post('/cleanup', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  try {
    const { rowCount: unopened } = await db.query(
      `UPDATE payment_requests
       SET status = 'expired', page_token = NULL
       WHERE status = 'pending'
         AND page_token IS NOT NULL
         AND page_token_expires < UTC_TIMESTAMP()`,
    );

    // The grace period is added in SQL so the comparison stays in the database's
    // UTC clock, the same one `page_token_expires` was written against.
    const hours = abandonedRequestHours();
    const { rowCount: abandoned } = await db.query(
      `UPDATE payment_requests
       SET status = 'expired'
       WHERE status = 'pending'
         AND page_token IS NULL
         AND page_token_expires < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)`,
      [hours],
    );

    // #1121 stage 2: a product purchase whose payment is over has to stop being
    // `pending_payment`, or its UNIQUE pending key blocks the member from ever
    // buying that Product again. Keyed on the request's status — including the
    // rows just expired above — so there is no second definition of when an
    // attempt is finished, and it is reported beside the totals rather than
    // folded into `expired`, which `.github/workflows/billing-run.yml` parses.
    const purchasesCancelled = await cancelAbandonedPurchases();

    // #1325: a ProductSet Draft idle for more than two hours is deleted here as
    // well as lazily when its owner starts a new one. The statement re-evaluates
    // status and age in the database, so a set that was committed in between
    // survives. Reported beside the totals, never folded into `expired`.
    const draftsExpired = await expireDrafts();

    const expired = unopened + abandoned;
    req.log.info(
      { expired, unopened, abandoned, abandonedAfterHours: hours, purchasesCancelled },
      'payment_requests cleanup: expired rows',
    );
    res.json({
      expired,
      expired_unopened: unopened,
      expired_abandoned: abandoned,
      purchases_cancelled: purchasesCancelled,
      drafts_expired: draftsExpired,
    });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, 'billing cleanup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
