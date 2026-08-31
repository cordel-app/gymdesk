import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyWebhook } from '@clerk/backend/webhooks';
import { linkGymInvite } from './gym-users';
import { db } from '../infra/db';
import { getPaymentProvider } from '../payments';

/**
 * Clerk webhook receiver. Backstops the admin-app self-heal: when an invited
 * team member finishes sign-up, Clerk fires `user.created` with the
 * invitation's `public_metadata` (including `gym_invite`) copied onto the user.
 * We materialize their gym_memberships row here, so activation no longer
 * depends on the user ever landing back on the admin app.
 *
 * Mounted BEFORE express.json() with a raw body parser — signature
 * verification requires the exact raw bytes Clerk signed.
 *
 * Env: CLERK_WEBHOOK_SIGNING_SECRET (whsec_...) from the Clerk dashboard.
 */
export const clerkWebhookRouter = Router();

clerkWebhookRouter.post('/', async (req: Request, res: Response) => {
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) {
    console.error('Clerk webhook received but CLERK_WEBHOOK_SIGNING_SECRET is not set');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let evt: any;
  try {
    // req.body is a Buffer (express.raw). Rebuild a Fetch Request so
    // verifyWebhook can read the raw text and svix-* headers it signed.
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value != null) headers.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    const request = new globalThis.Request('https://webhook.local/webhooks/clerk', {
      method: 'POST',
      headers,
      body: req.body,
    });
    evt = await verifyWebhook(request, {
      signingSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
    });
  } catch (err: any) {
    console.error('Clerk webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    if (evt.type === 'user.created') {
      const userId = evt.data?.id;
      if (userId) {
        const row = await linkGymInvite(userId);
        if (row) {
          console.log(`Clerk webhook ${evt.type}: linked gym invite for user ${userId}`);
        }
      }
    }
    // Always ack quickly so Clerk doesn't retry a processed event.
    return res.status(200).json({ received: true });
  } catch (err: any) {
    // User no longer exists (created then deleted before we processed the
    // event) — nothing to link, ack so Clerk stops retrying.
    if (err.status === 404) {
      console.warn(`Clerk webhook ${evt?.type}: user gone, skipping`);
      return res.status(200).json({ received: true, skipped: 'user_not_found' });
    }
    console.error(`Clerk webhook ${evt?.type} processing error:`, err.message);
    // 500 lets Clerk retry transient DB failures.
    return res.status(500).json({ error: 'Processing failed' });
  }
});

// ── Payment webhook ────────────────────────────────────────────────────────────

export const paymentWebhookRouter = Router();

const paymentWebhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests' }),
});

/**
 * Monei webhook receiver. Mounted BEFORE express.json() with a raw body parser
 * so the HMAC signature can be verified against the exact raw bytes Monei signed.
 *
 * Fail-fast: parseWebhook() verifies the HMAC as its FIRST operation.
 * If the signature is invalid, it throws and we return 400 immediately —
 * no DB query is made. This prevents forged-payload floods from creating DB load.
 */
paymentWebhookRouter.post(
  '/',
  paymentWebhookRateLimit as any,
  async (req: Request, res: Response) => {
    let payload: Awaited<ReturnType<ReturnType<typeof getPaymentProvider>['parseWebhook']>>;

    try {
      payload = await getPaymentProvider().parseWebhook(
        req.headers as Record<string, string | string[] | undefined>,
        req.body as Buffer,
      );
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'Payment webhook signature invalid');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    req.log.info({ orderId: payload.orderId, status: payload.status }, 'Payment webhook received');

    try {
      const { rows } = await db.query<{
        id: number;
        gym_id: string;
        user_membership_id: number;
        member_id: number;
        charge_type_id: number;
        amount: string;
        status: string;
      }>(
        `SELECT id, gym_id, user_membership_id, member_id, charge_type_id, amount, status
         FROM payment_requests WHERE provider_order = ?`,
        [payload.orderId],
      );

      if (!rows[0]) {
        req.log.warn({ orderId: payload.orderId }, 'Payment webhook: no matching payment_request');
        return res.status(200).json({ received: true });
      }

      const pr = rows[0];

      if (pr.status !== 'pending') {
        req.log.info({ orderId: payload.orderId, status: pr.status }, 'Payment webhook: already processed, skipping');
        return res.status(200).json({ received: true });
      }

      if (payload.status === 'completed') {
        await db.transaction(async (tx) => {
          await tx.query(
            `UPDATE payment_requests
             SET status = 'completed', provider_ref = ?, completed_at = UTC_TIMESTAMP()
             WHERE id = ?`,
            [payload.providerRef, pr.id],
          );

          await tx.query(
            `INSERT INTO billing_events
               (gym_id, user_membership_id, member_id, event_type, amount, charge_type_id, source, actor_user_id)
             VALUES (?, ?, ?, 'payment_recorded', ?, ?, 'provider', NULL)`,
            [pr.gym_id, pr.user_membership_id, pr.member_id, pr.amount, pr.charge_type_id],
          );

          if (payload.paymentToken && payload.sequenceId) {
            await tx.query(
              `INSERT INTO payment_methods
                 (gym_id, member_id, provider, payment_token, sequence_id, card_last4, card_brand)
               VALUES (?, ?, 'monei', ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE
                 payment_token = VALUES(payment_token),
                 sequence_id   = VALUES(sequence_id),
                 card_last4    = VALUES(card_last4),
                 card_brand    = VALUES(card_brand)`,
              [pr.gym_id, pr.member_id, payload.paymentToken, payload.sequenceId, payload.cardLast4, payload.cardBrand],
            );

            // Stamp next_billing_date on the membership (only if not yet set).
            // Uses billing_policies.recurring_billing_interval/unit to compute
            // the first due date relative to starts_at.
            await tx.query(
              `UPDATE user_memberships um
               JOIN billing_policies bp ON bp.membership_plan_id = um.membership_plan_id
               SET um.next_billing_date = CASE bp.recurring_billing_unit
                 WHEN 'day'   THEN DATE_ADD(um.starts_at, INTERVAL bp.recurring_billing_interval DAY)
                 WHEN 'week'  THEN DATE_ADD(um.starts_at, INTERVAL bp.recurring_billing_interval WEEK)
                 WHEN 'month' THEN DATE_ADD(um.starts_at, INTERVAL bp.recurring_billing_interval MONTH)
                 WHEN 'year'  THEN DATE_ADD(um.starts_at, INTERVAL bp.recurring_billing_interval YEAR)
               END
               WHERE um.id = ? AND um.next_billing_date IS NULL`,
              [pr.user_membership_id],
            );
          }
        });

        req.log.info({ orderId: payload.orderId, paymentRequestId: pr.id }, 'Payment webhook: completed');
      } else {
        await db.query(
          `UPDATE payment_requests SET status = ?, provider_ref = ? WHERE id = ?`,
          [payload.status === 'failed' ? 'failed' : 'expired', payload.providerRef, pr.id],
        );
        req.log.info({ orderId: payload.orderId, status: payload.status }, 'Payment webhook: non-success status');
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      req.log.error({ orderId: payload.orderId, err: (err as Error).message }, 'Payment webhook processing error');
      return res.status(500).json({ error: 'Processing failed' });
    }
  },
);
