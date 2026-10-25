import { Router, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { verifyWebhook } from '@clerk/backend/webhooks';
import { linkGymInvite } from '../infra/staff-access';
import { unlinkClerkAccount } from '../infra/clerk-account-links';
import { recordPlatformAudit } from '../infra/audit';
import { getPaymentProvider } from '../payments';
import { paymentWebhookClientKey } from '../domain/forwardedClient';
import { settlePaymentRequest } from './payment-settlement';

/**
 * Clerk webhook receiver. `user.deleted` (#709) removes every Gymdesk link to
 * the deleted account. `user.created` backstops the admin-app self-heal: when an invited
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
    // #709: an account deleted in Clerk (Dashboard, or our own deletes echoing
    // back) must leave no Gymdesk rows pointing at it. Idempotent, so a retry or
    // the echo of a delete we already cleaned up is a no-op.
    if (evt.type === 'user.deleted') {
      const userId = evt.data?.id;
      if (userId) {
        const cleaned = await unlinkClerkAccount(userId);
        if (cleaned.memberships > 0 || cleaned.members > 0) {
          console.log(`Clerk webhook ${evt.type}: unlinked user ${userId}`, cleaned);
          recordPlatformAudit(null, {
            action: 'delete',
            entityType: 'clerk_account',
            entityId: userId,
            next: { removed_gym_memberships: cleaned.memberships, unlinked_members: cleaned.members },
            actor: { userId: null, name: 'Clerk (user.deleted)' },
            source: 'system',
          });
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

// 60/min per IP. The key is the client address, not the request's peer: since
// #1083 Monei posts to the isolated payment app, whose nginx relays the request
// to the API's internal address, so the chain in front of this one route is one
// hop longer than `trust proxy` accounts for. Counting the relay as the client
// would put every gym's payment confirmations in one 60/min bucket — see
// domain/forwardedClient.ts for why the extra hop is declared per route and
// defaults to none (where this is `req.ip`, exactly as before).

const paymentWebhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const client = paymentWebhookClientKey({
      ip: req.ip,
      socketAddress: req.socket.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for'],
    });
    return client === '' ? '' : ipKeyGenerator(client);
  },
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests' }),
});

// Monei's dashboard preflights a new webhook URL with a GET before saving it
// and rejects the URL if that returns a non-2xx — this route only otherwise
// handles POST, so give the preflight a 200 to check against.
paymentWebhookRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
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
      await settlePaymentRequest(payload, { via: 'webhook', log: req.log });
      return res.status(200).json({ received: true });
    } catch (err) {
      req.log.error({ orderId: payload.orderId, err: (err as Error).message }, 'Payment webhook processing error');
      return res.status(500).json({ error: 'Processing failed' });
    }
  },
);
