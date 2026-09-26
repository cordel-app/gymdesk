import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { db } from '../infra/db';
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';
import { ASSIGNMENT_CADENCE } from './assigned-plan-snapshot';
import { advanceBillingDate } from '../domain/billingDate';
import { ClaimResult, RunLogTable, claimRun, finishRun } from '../infra/run-log';
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
        processed: 0, succeeded: 0, failed: 0, waived: 0,
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
          await tx.query(
            'UPDATE user_memberships SET next_billing_date = ? WHERE id = ?',
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

            await tx.query(
              `UPDATE user_memberships
               SET last_billed_at = UTC_TIMESTAMP(), next_billing_date = ?
               WHERE id = ?`,
              [nextBillingDate, row.id],
            );
          });

          req.log.info(
            { orderId, memberId: row.member_id, gymId: row.gym_id, provider: row.provider, amount },
            'billing/run: charge succeeded',
          );
          succeeded++;
        } else {
          // Failed charge — billing event first, then payment_requests.
          const failNote = [result.errorCode, result.errorMessage].filter(Boolean).join(': ');
          // Same `insertId` fix as the successful branch above: the rejected
          // charge's `payment_requests` row was being written with an
          // undefined `billing_event_id`, which threw before it was inserted.
          const { insertId: billingEventId } = await db.query(
            `INSERT INTO billing_events
               (gym_id, user_membership_id, member_id, event_type, amount,
                charge_type_id, source, actor_user_id, notes)
             VALUES (?, ?, ?, 'failed_billing', ?, ?, 'system', NULL, ?)`,
            [row.gym_id, row.id, row.member_id, amount, membershipFeeChargeTypeId, failNote || null],
          );

          // #640: the rejection reason is stored on the transaction too, not
          // only in the ledger row's notes, so the Billing Event Details view
          // can explain a failure at the attempt that produced it.
          await db.query(
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

          req.log.warn(
            { orderId, memberId: row.member_id, gymId: row.gym_id, errorCode: result.errorCode },
            'billing/run: charge failed',
          );
          failed++;
        }
      } catch (chargeErr) {
        // Provider API error — emit failed_billing event and continue; no payment_requests row.
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

    req.log.info({ processed, succeeded, failed, waived }, 'billing/run: complete');
    res.json({ processed, succeeded, failed, waived });
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
 * Expires pending payment_requests whose page_token TTL has passed.
 * Auth: X-Internal-Secret header (BILLING_INTERNAL_SECRET env var).
 */
billingRouter.post('/cleanup', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  try {
    const { rowCount } = await db.query(
      `UPDATE payment_requests
       SET status = 'expired', page_token = NULL
       WHERE status = 'pending' AND page_token_expires < UTC_TIMESTAMP()`,
    );

    req.log.info({ expired: rowCount }, 'payment_requests cleanup: expired rows');
    res.json({ expired: rowCount });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, 'billing cleanup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
