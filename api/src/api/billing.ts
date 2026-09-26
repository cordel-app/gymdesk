import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { db } from '../infra/db';
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';
import { ASSIGNMENT_CADENCE } from './assigned-plan-snapshot';
import { advanceBillingDate } from '../domain/billingDate';
import { registerRejection } from '../domain/billingDunning';
import { abandonedRequestHours } from '../domain/paymentRequestExpiry';
import { recordStatusChange } from './billing-events';
import { ClaimResult, RunLogTable, claimRun, finishRun } from '../infra/run-log';
import { issueReceiptNumber } from '../domain/receiptNumbers';
import {
  FEE_ASSIGNMENT_COLUMNS,
  FeeAssignmentRow,
  priceMembershipFeeOn,
} from './membership-fee-pricing';

// The date arithmetic itself lives in `domain/billingDate.ts` since #635
// stage 11 (see that module for why), and is re-exported here so every caller
// that has always imported it from the router keeps working.
export { advanceBillingDate } from '../domain/billingDate';

export const billingRouter = Router();

/** #780: the history this run claims a row in. */
const BILLING_RUN_LOG: RunLogTable = 'billing_run_log';

// mysql2 may return DATE columns as Date objects rather than strings depending
// on the connection's timezone config (same note as user-memberships.ts) — the
// pricing engine compares dates as strings.
function toDateOnly(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

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
 * Nightly MIT billing run. Finds all active memberships whose next_billing_date
 * is today or in the past and a payment_methods row exists, then fires an MIT
 * charge against the stored payment_token/sequence_id for each.
 *
 * #635 stage 11: the amount is no longer `final_price` flat — it is the fee the
 * assignment's own snapshot owes **on the date being billed**, resolved by
 * `priceMembershipFeeOn` through the same engine the Billing Simulation uses.
 * A cycle that owes nothing (a Free Period, a Bonus Duration, a Promotion's
 * free month) is not sent to the provider at all: it records a `waived_billing`
 * ledger row and moves `next_billing_date` on.
 *
 * #635 stage 12: the *price* of a cycle that is not waived comes from that same
 * resolver too, so a Promotion's Membership Fee Benefit stops when the
 * Promotion's Free/Paid/Bonus timeline does instead of discounting for ever.
 * #635 stage 15 made that unconditional and deleted the stored
 * `final_price` it replaced — there is no flag and no second rule left, so the
 * run has exactly one way to know what a cycle costs.
 *
 * Auth: X-Internal-Secret header (BILLING_INTERNAL_SECRET env var).
 *
 * #785 — a rejected charge now escalates instead of repeating for ever. The
 * first rejection records itself and bumps `user_memberships.failed_attempts`;
 * because `next_billing_date` does not move, the retry is the next run day. The
 * second consecutive rejection of that same due cycle **pauses** the assignment
 * (`recordStatusChange`, `active → paused`, `source = 'system'`), which takes it
 * out of this query's `WHERE status = 'active'`. A settled or waived cycle
 * clears the counter. Only a provider *rejection* counts — a provider exception
 * and a missing payment method do not (`domain/billingDunning.ts`).
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
  // consecutive rejection. Reported beside the other counters (the workflow
  // reads the four named ones by name, so an extra field is additive) but
  // deliberately *not* written to `billing_run_log`: the pause is already a
  // `status_changed` ledger row, which is where it is explicable from.
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
    // Look up membership_fee charge type id (used for billing_events rows).
    const { rows: ctRows } = await db.query<{ id: number }>(
      "SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1",
    );
    const membershipFeeChargeTypeId = ctRows[0]?.id ?? null;

    // Query all active memberships due for billing. The cadence is the
    // assignment's own frozen pair, its Plan's only as the fallback
    // (ASSIGNMENT_CADENCE) — hence the LEFT JOIN: an INNER one would drop
    // every assignment whose Plan has since lost its billing policy.
    const { rows: due } = await db.query<FeeAssignmentRow & {
      member_id: number;
      next_billing_date: Date | string;
      recurring_billing_interval: number;
      recurring_billing_unit: 'day' | 'week' | 'month' | 'year';
      payment_token: string | null;
      sequence_id: string | null;
      provider: string;
    }>(
      `SELECT ${FEE_ASSIGNMENT_COLUMNS},
              um.member_id,
              ${ASSIGNMENT_CADENCE.interval()} AS recurring_billing_interval,
              ${ASSIGNMENT_CADENCE.unit()} AS recurring_billing_unit,
              pm.payment_token, pm.sequence_id, pm.provider
       FROM user_memberships um
       LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
       LEFT JOIN billing_policies bp ON bp.membership_plan_id = um.membership_plan_id
       JOIN payment_methods pm ON pm.member_id = um.member_id AND pm.gym_id = um.gym_id
       WHERE um.status = 'active'
         AND um.next_billing_date IS NOT NULL
         AND um.next_billing_date <= UTC_DATE()
         AND ${ASSIGNMENT_CADENCE.interval()} IS NOT NULL
         AND ${ASSIGNMENT_CADENCE.unit()} IS NOT NULL`,
    );

    req.log.info({ count: due.length }, 'billing/run: memberships due for billing');

    for (const row of due) {
      processed++;
      // The cycle being billed is the one `next_billing_date` names, so that is
      // the date the assignment's Billing & Duration and its Promotions are
      // resolved on — never "today", which may be days later if a run was missed.
      const billingDate = toDateOnly(row.next_billing_date);
      const priced = await priceMembershipFeeOn(row, billingDate);
      const amount = priced.amount;
      const nextBillingDate = advanceBillingDate(
        row.next_billing_date,
        row.recurring_billing_interval,
        row.recurring_billing_unit,
      );
      const orderId = `BILLING-${row.gym_id.slice(0, 8)}-${row.id}-${crypto.randomUUID().slice(0, 8)}`;

      if (priced.waived) {
        // Nothing is owed for this cycle — a Free Period, a Bonus Duration or a
        // Promotion's own free month. The provider is never called for €0, but
        // the cycle is still recorded, so the ledger shows the waiver instead
        // of a gap, and `next_billing_date` moves on exactly as it would have.
        // `last_billed_at` deliberately does not: nothing was billed.
        await db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO billing_events
               (gym_id, user_membership_id, member_id, event_type, amount,
                charge_type_id, source, actor_user_id, notes)
             VALUES (?, ?, ?, 'waived_billing', 0, ?, 'system', NULL, ?)`,
            [row.gym_id, row.id, row.member_id, membershipFeeChargeTypeId, priced.periodStatus],
          );
          // #785: the cycle moved on, so whatever rejections the *previous*
          // cycle collected are spent — `failed_attempts` counts consecutive
          // rejections of the cycle `next_billing_date` names, and this is a
          // different one now. Clearing it here (and not only on a settled
          // charge) is what stops a rejection in March plus a rejection in
          // June, with a free month between them, from reading as two in a row.
          await tx.query(
            `UPDATE user_memberships
             SET next_billing_date = ?, failed_attempts = 0, last_failed_at = NULL
             WHERE id = ?`,
            [nextBillingDate, row.id],
          );
        });
        req.log.info(
          { memberId: row.member_id, gymId: row.gym_id, billingDate, periodStatus: priced.periodStatus },
          'billing/run: cycle waived — no charge',
        );
        waived++;
        continue;
      }

      if (!row.payment_token || !row.sequence_id) {
        // No payment method stored — emit a failed_billing event and continue.
        // #785: this is not a rejection, so it does not move the assignment
        // towards a pause. Nothing was attempted and there is no decline to
        // escalate; what it needs is a member who enters a card, which pausing
        // them does not bring about. See `domain/billingDunning.ts`.
        await db.query(
          `INSERT INTO billing_events
             (gym_id, user_membership_id, member_id, event_type, amount,
              charge_type_id, source, actor_user_id, notes)
           VALUES (?, ?, ?, 'failed_billing', ?, ?, 'system', NULL, 'no_payment_method')`,
          [row.gym_id, row.id, row.member_id, amount, membershipFeeChargeTypeId],
        );
        req.log.warn({ memberId: row.member_id, gymId: row.gym_id }, 'billing/run: no payment method — skipped');
        failed++;
        continue;
      }

      try {
        const result = await getPaymentProvider().executeRecurring({
          orderId,
          amount: toMinorUnits(amount),
          currency: 'EUR',
          paymentToken: row.payment_token,
          sequenceId: row.sequence_id,
        });

        if (result.success) {
          let settledBillingEventId = 0;
          // Billing event first so payment_requests can reference it.
          await db.transaction(async (tx) => {
            // `insertId` is a property of the query result, not of `rows` —
            // reading it off `rows` yielded `undefined`, which mysql2 rejects
            // as a bind parameter on the next INSERT. The whole successful
            // branch therefore threw, was caught below as a "provider error"
            // and rolled back, so a charge the provider had already taken was
            // recorded as a failure and `next_billing_date` never moved on.
            const { insertId: billingEventId } = await tx.query(
              `INSERT INTO billing_events
                 (gym_id, user_membership_id, member_id, event_type, amount,
                  charge_type_id, source, actor_user_id)
               VALUES (?, ?, ?, 'recurring_payment', ?, ?, 'system', NULL)`,
              [row.gym_id, row.id, row.member_id, amount, membershipFeeChargeTypeId],
            );
            settledBillingEventId = billingEventId;

            await tx.query(
              `INSERT INTO payment_requests
                 (gym_id, user_membership_id, member_id, amount, currency,
                  charge_type_id, billing_event_id, status, provider,
                  provider_order, provider_ref, source, created_at, completed_at)
               VALUES (?, ?, ?, ?, 'EUR', ?, ?, 'completed', ?, ?, ?,
                       'billing_run', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
              [
                row.gym_id, row.id, row.member_id, amount,
                membershipFeeChargeTypeId, billingEventId,
                row.provider, orderId, result.providerRef,
              ],
            );

            // #785: a settled charge clears the dunning state — the cycle is
            // paid and the next one starts from zero rejections, so a decline
            // last month can never combine with one next month to pause a
            // member who is paying.
            await tx.query(
              `UPDATE user_memberships
               SET last_billed_at = UTC_TIMESTAMP(), next_billing_date = ?,
                   failed_attempts = 0, last_failed_at = NULL
               WHERE id = ?`,
              [nextBillingDate, row.id],
            );
          });

          req.log.info(
            { orderId, memberId: row.member_id, gymId: row.gym_id, provider: row.provider, amount },
            'billing/run: charge succeeded',
          );
          succeeded++;

          // #787: a settled recurring charge gets its receipt number here, so
          // the member finds the receipt on their own billing history without
          // a staff member having to issue it first.
          //
          // Deliberately *after* the charge transaction commits, in one of its
          // own — not inside it. That transaction records money the provider
          // has already taken; a failure in it rolls the record back while the
          // charge stands, which is the exact bug the `insertId` comment above
          // documents. A receipt number is a convenience that the on-demand
          // `POST /payments/:id/receipt` can still allocate later, so it is
          // never worth risking the charge record for. Hence the swallow: the
          // run logs and carries on.
          try {
            const issued = await db.transaction((tx) =>
              issueReceiptNumber(tx, row.gym_id, settledBillingEventId),
            );
            receiptsIssued += issued.allocated ? 1 : 0;
          } catch (receiptErr: any) {
            req.log.error(
              {
                err: receiptErr,
                billingEventId: settledBillingEventId,
                gymId: row.gym_id,
                memberId: row.member_id,
              },
              'billing/run: receipt number allocation failed (charge stands, issue on demand)',
            );
          }
        } else {
          // Failed charge — billing event first, then payment_requests.
          const failNote = [result.errorCode, result.errorMessage].filter(Boolean).join(': ');

          // #785: the provider answered, and the answer was no. This is the one
          // failure kind that escalates — the first rejection only records
          // itself, the second consecutive one for the same due cycle pauses
          // the assignment, which is what stops the run re-charging a declined
          // card (and paying a fee for it) every night for ever. The retry is
          // the *next run day* by construction: `next_billing_date` does not
          // move, so the same assignment is selected again tomorrow.
          //
          // The decision is taken *inside* the transaction below, off the locked
          // row — never off `row`, which was read before the provider round
          // trip. A staff Retry that settled or a Manual payment recorded in
          // that window clears the pair (`clearDunningState`), and deciding
          // from the stale count would write it back and pause a member who has
          // just paid.
          let dunning = { attempts: 0, pause: false };

          // One transaction for the whole rejection, unlike before: the ledger
          // row, its transaction, the attempt counter and the pause have to
          // agree, or a crash between them could pause an assignment with no
          // second `failed_billing` row explaining why.
          const pausedThisRow = await db.transaction(async (tx) => {
            // Same `insertId` fix as the successful branch above: the rejected
            // charge's `payment_requests` row was being written with an
            // undefined `billing_event_id`, which threw before it was inserted.
            const { insertId: billingEventId } = await tx.query(
              `INSERT INTO billing_events
                 (gym_id, user_membership_id, member_id, event_type, amount,
                  charge_type_id, source, actor_user_id, notes)
               VALUES (?, ?, ?, 'failed_billing', ?, ?, 'system', NULL, ?)`,
              [row.gym_id, row.id, row.member_id, amount, membershipFeeChargeTypeId, failNote || null],
            );

            // #640: the rejection reason is stored on the transaction too, not
            // only in the ledger row's notes, so the Billing Event Details view
            // can explain a failure at the attempt that produced it.
            //
            // `attempt` is deliberately left alone here. It counts attempts
            // *within one Billing Event* (#640), and this event is new: its only
            // transaction is its first attempt. The cross-night count that
            // decides the pause is `user_memberships.failed_attempts` — writing
            // it here as well would make the Details view of a one-transaction
            // event claim to be showing attempt 2 of something.
            await tx.query(
              `INSERT INTO payment_requests
                 (gym_id, user_membership_id, member_id, amount, currency,
                  charge_type_id, billing_event_id, status, provider,
                  provider_order, provider_ref, source, created_at,
                  failure_code, failure_message)
               VALUES (?, ?, ?, ?, 'EUR', ?, ?, 'failed', ?, ?, ?,
                       'billing_run', UTC_TIMESTAMP(), ?, ?)`,
              [
                row.gym_id, row.id, row.member_id, amount,
                membershipFeeChargeTypeId, billingEventId,
                row.provider, orderId, result.providerRef,
                result.errorCode ?? null, result.errorMessage?.slice(0, 500) ?? null,
              ],
            );

            // Re-read under a lock: minutes may have passed since the due query
            // and a staff member may have paused, cancelled or *settled* this
            // assignment in the meantime. Only an assignment that is still
            // `active` is ours to escalate, and the count we write has to be the
            // one this row carries now — see the note above the `dunning` decl.
            const { rows: locked } = await tx.query<{
              id: number; member_id: number; status: string;
              failed_attempts: number | string | null; rejected_today: number | string;
            }>(
              `SELECT id, member_id, status, failed_attempts,
                      (last_failed_at IS NOT NULL AND DATE(last_failed_at) = UTC_DATE()) AS rejected_today
                 FROM user_memberships WHERE id = ? AND gym_id = ? FOR UPDATE`,
              [row.id, row.gym_id],
            );
            if (locked.length === 0 || locked[0].status !== 'active') return false;

            dunning = registerRejection({
              previousAttempts: locked[0].failed_attempts,
              alreadyRejectedToday: Number(locked[0].rejected_today) === 1,
            });

            await tx.query(
              'UPDATE user_memberships SET failed_attempts = ?, last_failed_at = UTC_TIMESTAMP() WHERE id = ?',
              [dunning.attempts, row.id],
            );

            if (!dunning.pause) return false;

            // The escalation is the status the schema already has: a `paused`
            // assignment falls outside this run's `WHERE status = 'active'`, so
            // it is simply not selected again. The flip goes through the same
            // append-only ledger row every other transition writes, with
            // `source = 'system'` — nobody asked for it — exactly as the manual
            // Retry's own two-attempts rule does (#640 Q3).
            await tx.query(
              "UPDATE user_memberships SET status = 'paused' WHERE id = ?",
              [row.id],
            );
            await recordStatusChange(tx, {
              gymId: row.gym_id,
              userMembershipId: locked[0].id,
              memberId: locked[0].member_id,
              previousStatus: locked[0].status,
              newStatus: 'paused',
              source: 'system',
              actorUserId: null,
            });
            // Returned rather than assigned to an outer flag: the `paused`
            // counter must count commits, and a transaction can still fail
            // after its last statement.
            return true;
          });

          if (pausedThisRow) paused++;

          req.log.warn(
            {
              orderId, memberId: row.member_id, gymId: row.gym_id,
              errorCode: result.errorCode, attempt: dunning.attempts,
              membershipPaused: pausedThisRow,
            },
            'billing/run: charge failed',
          );
          failed++;
        }
      } catch (chargeErr) {
        // Provider API error — emit failed_billing event and continue; no payment_requests row.
        //
        // #785: a provider exception is **not** a rejection and does not count
        // towards the pause. The charge's outcome is unknown — it may even have
        // settled — so escalating on it would pause members for our own outage,
        // and a night when Monei is unreachable would pause a gym's whole book.
        // `failed_attempts` is therefore left exactly as it was: neither bumped
        // nor cleared. See `domain/billingDunning.ts`.
        req.log.error(
          { orderId, memberId: row.member_id, err: (chargeErr as Error).message },
          'billing/run: provider error',
        );
        await db.query(
          `INSERT INTO billing_events
             (gym_id, user_membership_id, member_id, event_type, amount,
              charge_type_id, source, actor_user_id, notes)
           VALUES (?, ?, ?, 'failed_billing', ?, ?, 'system', NULL, 'provider_error')`,
          [row.gym_id, row.id, row.member_id, amount, membershipFeeChargeTypeId],
        ).catch(() => {});
        failed++;
      }
    }

    await finishRun(BILLING_RUN_LOG, claim.runId, 'completed', { processed, succeeded, failed, waived });

    req.log.info(
      { processed, succeeded, failed, waived, paused, receiptsIssued },
      'billing/run: complete',
    );
    res.json({
      processed, succeeded, failed, waived, paused,
      receipts_issued: receiptsIssued,
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

    const expired = unopened + abandoned;
    req.log.info(
      { expired, unopened, abandoned, abandonedAfterHours: hours },
      'payment_requests cleanup: expired rows',
    );
    res.json({ expired, expired_unopened: unopened, expired_abandoned: abandoned });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, 'billing cleanup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
