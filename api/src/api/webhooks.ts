import { Router, type Request, type Response } from 'express';
import { verifyWebhook } from '@clerk/backend/webhooks';
import { linkGymInvite } from './gym-users';

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
