import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { db } from '../infra/db';
import { getPaymentProvider } from '../payments';

function advanceBillingDate(
  current: Date | string,
  interval: number,
  unit: 'day' | 'week' | 'month' | 'year',
): string {
  const d = new Date(current instanceof Date ? current.toISOString() : current);
  switch (unit) {
    case 'day':   d.setUTCDate(d.getUTCDate() + interval); break;
    case 'week':  d.setUTCDate(d.getUTCDate() + interval * 7); break;
    case 'month': d.setUTCMonth(d.getUTCMonth() + interval); break;
    case 'year':  d.setUTCFullYear(d.getUTCFullYear() + interval); break;
  }
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export const billingRouter = Router();

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
 * Auth: X-Internal-Secret header (BILLING_INTERNAL_SECRET env var).
 * Rate-limited: rejects with 429 if the last successful run was < 23 h ago.
 */
billingRouter.post('/run', async (req: Request, res: Response) => {
  if (!checkInternalSecret(req, res)) return;

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  try {
    // Rate-limit: reject a second call within 23 hours.
    const { rows: logRows } = await db.query<{ last_run_at: Date | null }>(
      'SELECT last_run_at FROM billing_run_log WHERE id = 1',
    );
    const lastRun = logRows[0]?.last_run_at;
    if (lastRun) {
      const diffMs = Date.now() - new Date(lastRun).getTime();
      const diffHours = diffMs / (1000 * 60 * 60);
      if (diffHours < 23) {
        req.log.warn({ lastRun, diffHours }, 'billing/run: rate-limited — run within last 23h');
        return res.status(429).json({ error: 'Billing run already executed within the last 23 hours' });
      }
    }

    // Stamp the run start time to prevent concurrent/duplicate runs.
    await db.query('UPDATE billing_run_log SET last_run_at = UTC_TIMESTAMP() WHERE id = 1');

    // Look up membership_fee charge type id (used for billing_events rows).
    const { rows: ctRows } = await db.query<{ id: number }>(
      "SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1",
    );
    const membershipFeeChargeTypeId = ctRows[0]?.id ?? null;

    // Query all active memberships due for billing.
    const { rows: due } = await db.query<{
      id: number;
      gym_id: string;
      member_id: number;
      next_billing_date: Date | string;
      recurring_billing_interval: number;
      recurring_billing_unit: 'day' | 'week' | 'month' | 'year';
      final_price: string;
      payment_token: string | null;
      sequence_id: string | null;
      provider: string;
    }>(
      `SELECT um.id, um.gym_id, um.member_id,
              um.next_billing_date,
              bp.recurring_billing_interval, bp.recurring_billing_unit,
              um.final_price,
              pm.payment_token, pm.sequence_id, pm.provider
       FROM user_memberships um
       JOIN billing_policies bp ON bp.membership_plan_id = um.membership_plan_id
       JOIN payment_methods pm ON pm.member_id = um.member_id AND pm.gym_id = um.gym_id
       WHERE um.status = 'active'
         AND um.next_billing_date IS NOT NULL
         AND um.next_billing_date <= UTC_DATE()`,
    );

    req.log.info({ count: due.length }, 'billing/run: memberships due for billing');

    for (const row of due) {
      processed++;
      const amount = parseFloat(row.final_price);
      const orderId = `BILLING-${row.gym_id.slice(0, 8)}-${row.id}-${crypto.randomUUID().slice(0, 8)}`;

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
          amount,
          currency: 'EUR',
          paymentToken: row.payment_token,
          sequenceId: row.sequence_id,
        });

        // Insert a minimal payment_requests row for auditability so MIT charges
        // appear in the Transactions admin page alongside manual ones.
        await db.query(
          `INSERT INTO payment_requests
             (gym_id, user_membership_id, member_id, amount, currency,
              charge_type_id, status, provider, provider_order, provider_ref,
              source, created_at, completed_at)
           VALUES (?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?,
                   'billing_run', UTC_TIMESTAMP(), ?)`,
          [
            row.gym_id,
            row.id,
            row.member_id,
            amount,
            membershipFeeChargeTypeId,
            result.success ? 'completed' : 'failed',
            row.provider,
            orderId,
            result.providerRef,
            result.success ? new Date() : null,
          ],
        );

        if (result.success) {
          // Insert success billing_event and advance next_billing_date.
          const nextBillingDate = advanceBillingDate(
            row.next_billing_date,
            row.recurring_billing_interval,
            row.recurring_billing_unit,
          );

          await db.transaction(async (tx) => {
            await tx.query(
              `INSERT INTO billing_events
                 (gym_id, user_membership_id, member_id, event_type, amount,
                  charge_type_id, source, actor_user_id)
               VALUES (?, ?, ?, 'recurring_payment', ?, ?, 'system', NULL)`,
              [row.gym_id, row.id, row.member_id, amount, membershipFeeChargeTypeId],
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
          // Failed charge — emit event; do NOT cancel the membership.
          const failNote = [result.errorCode, result.errorMessage].filter(Boolean).join(': ');
          await db.query(
            `INSERT INTO billing_events
               (gym_id, user_membership_id, member_id, event_type, amount,
                charge_type_id, source, actor_user_id, notes)
             VALUES (?, ?, ?, 'failed_billing', ?, ?, 'system', NULL, ?)`,
            [row.gym_id, row.id, row.member_id, amount, membershipFeeChargeTypeId, failNote || null],
          );

          req.log.warn(
            { orderId, memberId: row.member_id, gymId: row.gym_id, errorCode: result.errorCode },
            'billing/run: charge failed',
          );
          failed++;
        }
      } catch (chargeErr) {
        // Provider API error — emit failed_billing event and continue.
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

    req.log.info({ processed, succeeded, failed }, 'billing/run: complete');
    res.json({ processed, succeeded, failed });
  } catch (err) {
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
