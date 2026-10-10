import { activateWithEvents } from './product-set-configuration';
import { Router, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { verifyWebhook } from '@clerk/backend/webhooks';
import { linkGymInvite } from '../infra/staff-access';
import { unlinkClerkAccount } from '../infra/clerk-account-links';
import { recordPlatformAudit } from '../infra/audit';
import { db } from '../infra/db';
import { getPaymentProvider } from '../payments';
import { stampFirstNextBillingDate } from '../domain/nextBillingDateStamp';
import { PENDING_PAYMENT_STATUS, commitAssignment } from './assignment-commit';
import { CARD_UPDATE_SOURCE } from '../domain/storedCards';
import { PRODUCT_PURCHASE_SOURCE } from '../domain/memberProductPurchase';
import { cancelProductPurchase, completeProductPurchase } from './me-products';
import { paymentWebhookClientKey } from '../domain/forwardedClient';

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
      const { rows } = await db.query<{
        id: number;
        gym_id: string;
        user_membership_id: number;
        member_id: number;
        charge_type_id: number | null;
        amount: string;
        status: string;
        source: string;
        billing_event_id: number | null;
      }>(
        `SELECT id, gym_id, user_membership_id, member_id, charge_type_id, amount, status, source, billing_event_id
         FROM payment_requests WHERE provider_order = ?`,
        [payload.orderId],
      );

      if (!rows[0]) {
        req.log.warn({ orderId: payload.orderId }, 'Payment webhook: no matching payment_request');
        return res.status(200).json({ received: true });
      }

      const pr = rows[0];

      // #789 — the provider is the source of truth about money. A `pending` row
      // is the normal case, but an `expired` one still accepts a `completed`
      // webhook: `POST /billing/cleanup` no longer expires a request whose page
      // was opened before its long window runs out, and Monei itself can retry a
      // webhook after a transient 5xx on our side, yet neither guarantee is worth
      // losing a charge over. Refusing it is what produced the defect this
      // belongs to — a member charged, with no completed request, no stored card
      // and no `next_billing_date`.
      //
      // Deliberately narrow: only `completed` may revive a terminal row. A
      // `failed`/`expired` webhook on an already-terminal row changes nothing,
      // and an already-`completed` row is still skipped, which is what keeps the
      // handler idempotent under Monei's retries.
      const settleable =
        pr.status === 'pending' || (pr.status === 'expired' && payload.status === 'completed');

      if (!settleable) {
        req.log.info({ orderId: payload.orderId, status: pr.status }, 'Payment webhook: already processed, skipping');
        return res.status(200).json({ received: true });
      }

      // #788: a card replacement is a zero-amount verification, not a payment.
      // It settles no cycle, so it writes no `payment_recorded` Billing Event,
      // stamps no `next_billing_date`, and clears none of #785's dunning
      // counters — the rejection that started the member replacing their card is
      // still owed until something actually pays it. All it does is hand the new
      // token to the same upsert a first payment uses. A verification that did
      // not complete falls through to the branches below, which only move the
      // request's own status: the previous token stays exactly where it was.
      if (payload.status === 'completed' && pr.source === CARD_UPDATE_SOURCE) {
        await db.transaction(async (tx) => {
          await tx.query(
            `UPDATE payment_requests
             SET status = 'completed', provider_ref = ?, completed_at = UTC_TIMESTAMP()
             WHERE id = ?`,
            [payload.providerRef, pr.id],
          );

          if (payload.paymentToken && payload.sequenceId) {
            await tx.query(
              `INSERT INTO payment_methods
                 (gym_id, member_id, provider, payment_token, sequence_id, card_last4, card_brand, updated_at)
               VALUES (?, ?, 'monei', ?, ?, ?, ?, UTC_TIMESTAMP())
               ON DUPLICATE KEY UPDATE
                 payment_token = VALUES(payment_token),
                 sequence_id   = VALUES(sequence_id),
                 card_last4    = VALUES(card_last4),
                 card_brand    = VALUES(card_brand),
                 updated_at    = UTC_TIMESTAMP()`,
              [pr.gym_id, pr.member_id, payload.paymentToken, payload.sequenceId, payload.cardLast4, payload.cardBrand],
            );
          } else {
            // The verification succeeded but the provider returned no reusable
            // token, so there is nothing to store and the old card still stands.
            // Logged rather than failed: retrying the webhook cannot conjure a
            // token, and the member's next attempt is the way out.
            req.log.warn({ orderId: payload.orderId }, 'Payment webhook: card update completed without a token');
          }
        });

        req.log.info({ orderId: payload.orderId, paymentRequestId: pr.id }, 'Payment webhook: card updated');
      } else if (payload.status === 'completed' && pr.source === PRODUCT_PURCHASE_SOURCE) {
        // #1121 stage 2: a Product the member bought. It settles no membership
        // cycle, which is what every difference from the fee branch below comes
        // from:
        //
        //  * it writes a `payment_recorded` Billing Event with **no**
        //    `user_membership_id` (migration 228 made the column nullable) —
        //    money did arrive, so it belongs in the ledger both the member's
        //    Payments card and the staff pages read, and it is receipt-able by
        //    the existing predicate (#787) because it is a real payment;
        //  * it stamps **no** `next_billing_date` and clears **none** of #785's
        //    dunning counters: a rejected membership cycle is still owed after
        //    a member buys a locker, and only something that settles *that*
        //    cycle may clear the pair;
        //  * it stores **no** card. A one-off purchase authorises one charge,
        //    so the token this payment may have produced is not the member
        //    agreeing to recurring charges — #788's replacement flow and the
        //    first fee payment are where a card comes from.
        //
        // The purchase's own `UPDATE` is constrained on `pending_payment`, so a
        // webhook delivered twice completes one row (#1118 §10).
        await db.transaction(async (tx) => {
          await tx.query(
            `UPDATE payment_requests
             SET status = 'completed', provider_ref = ?, provider_status = ?, completed_at = UTC_TIMESTAMP()
             WHERE id = ?`,
            [payload.providerRef, payload.providerStatus ?? 'SUCCEEDED', pr.id],
          );

          // The purchase's `product_purchase` Billing Event was written with the
          // request (#1325 PR 2), so there is nothing to insert: the request
          // becoming `completed` is what moves the event's derived status to
          // paid. A request that predates that change has no event, and gets
          // one here so the ledger still records the money that arrived.
          if (pr.billing_event_id == null) {
            const { insertId: billingEventId } = await tx.query(
              `INSERT INTO billing_events
                 (gym_id, user_membership_id, member_id, event_type, amount, charge_type_id, source, actor_user_id)
               VALUES (?, NULL, ?, 'product_purchase', ?, ?, 'provider', NULL)`,
              [pr.gym_id, pr.member_id, pr.amount, pr.charge_type_id],
            );
            await tx.query(
              `UPDATE payment_requests SET billing_event_id = ? WHERE id = ?`,
              [billingEventId, pr.id],
            );
          }

          const completed = await completeProductPurchase(tx, pr.gym_id, pr.id);
          if (completed === 0) {
            // The payment is real either way, so the Billing Event above
            // stands; what is missing is a purchase row to mark, which means
            // one of the two was already completed or was never written.
            req.log.warn(
              { orderId: payload.orderId, paymentRequestId: pr.id },
              'Payment webhook: product purchase payment with no pending purchase to complete',
            );
          }
        });

        req.log.info(
          { orderId: payload.orderId, paymentRequestId: pr.id },
          'Payment webhook: product purchase completed',
        );
      } else if (payload.status === 'completed') {
        if (pr.status === 'expired') {
          req.log.warn(
            { orderId: payload.orderId, paymentRequestId: pr.id },
            'Payment webhook: completing a request cleanup had already expired',
          );
        }
        await db.transaction(async (tx) => {
          await tx.query(
            `UPDATE payment_requests
             SET status = 'completed', provider_ref = ?, provider_status = ?, completed_at = UTC_TIMESTAMP()
             WHERE id = ?`,
            [payload.providerRef, payload.providerStatus ?? 'SUCCEEDED', pr.id],
          );

          // db.query()'s wrapper puts insertId at the top level for an
          // INSERT (rows is [] — there's nothing to select), not nested
          // under rows — reading it off rows here always came back
          // undefined, which crashed the next UPDATE's bind params and
          // rolled back this whole transaction on every real completion.
          // #1288: a first payment started from the Members App's Save & Pay
          // already has its Billing Event (written before the money moved,
          // `createPlanCheckout()`), so the payment settles that event — its
          // status derives from this request, which just became `completed` —
          // instead of appending a second one for the same charge.
          if (pr.billing_event_id == null) {
            const { insertId: billingEventId } = await tx.query(
              `INSERT INTO billing_events
                 (gym_id, user_membership_id, member_id, event_type, amount, charge_type_id, source, actor_user_id)
               VALUES (?, ?, ?, 'payment_recorded', ?, ?, 'provider', NULL)`,
              [pr.gym_id, pr.user_membership_id, pr.member_id, pr.amount, pr.charge_type_id],
            );

            await tx.query(
              `UPDATE payment_requests SET billing_event_id = ? WHERE id = ?`,
              [billingEventId, pr.id],
            );
          }

          // #785: money arrived for this cycle, so the nightly run's dunning
          // state is spent — a member who was one rejection away from being
          // paused and then paid the checkout link must not stay one rejection
          // away. This is the third money-arrival path, beside the run's own
          // success branch and the two staff actions' `clearDunningState()`;
          // it is written here, inside this transaction, because the payment and
          // the reset have to land together. Unconditional on the token branch
          // below: the cycle is settled whether or not the provider handed us a
          // reusable token.
          await tx.query(
            `UPDATE user_memberships SET failed_attempts = 0, last_failed_at = NULL
             WHERE id = ? AND gym_id = ?`,
            [pr.user_membership_id, pr.gym_id],
          );

          if (payload.paymentToken && payload.sequenceId) {
            await tx.query(
              `INSERT INTO payment_methods
                 (gym_id, member_id, provider, payment_token, sequence_id, card_last4, card_brand, updated_at)
               VALUES (?, ?, 'monei', ?, ?, ?, ?, UTC_TIMESTAMP())
               ON DUPLICATE KEY UPDATE
                 payment_token = VALUES(payment_token),
                 sequence_id   = VALUES(sequence_id),
                 card_last4    = VALUES(card_last4),
                 card_brand    = VALUES(card_brand),
                 updated_at    = UTC_TIMESTAMP()`,
              [pr.gym_id, pr.member_id, payload.paymentToken, payload.sequenceId, payload.cardLast4, payload.cardBrand],
            );

            // Stamp next_billing_date on the membership (only if not yet set).
            // #790: the first cycle boundary of the `starts_at`-anchored
            // schedule *strictly after today*, never `starts_at + cadence`
            // unconditionally — on a back-dated assignment that date is in the
            // past, and the nightly run then charged one elapsed cycle per
            // night, the last of them the very cycle this payment was priced on.
            // The elapsed cycles are written off. The cadence is the
            // assignment's own via ASSIGNMENT_CADENCE (LEFT JOIN, #635 stage 3).
            if (pr.user_membership_id != null) {
              await stampFirstNextBillingDate(tx, pr.user_membership_id, pr.gym_id);
            }
          }

          // #1108 stage 2: a first payment on a Pending Payment row is what
          // activates it — the same commit `POST /:id/activate` runs, with the
          // replacement the staff confirmed at Save & Pay taken as given (the
          // money has arrived; a paid-up member must not be left planless).
          // A row in any other status is untouched, so a renewal paid through
          // the checkout link changes nothing here.
          if (pr.user_membership_id != null) {
            const committed = await commitAssignment(tx, {
              gymId: pr.gym_id, userMembershipId: pr.user_membership_id,
              fromStatuses: [PENDING_PAYMENT_STATUS], confirm: true,
              source: 'provider', actorUserId: null,
            });
            // `not_committable` is the ordinary case — a renewal paid on an
            // already-active row. Anything else is a paid row left pending,
            // which staff must resolve by hand, so it is an error rather than
            // a warning.
            if (committed.kind !== 'committed' && committed.kind !== 'not_committable') {
              req.log.error(
                { orderId: payload.orderId, userMembershipId: pr.user_membership_id, outcome: committed },
                'Payment webhook: a paid membership pending payment could not be activated',
              );
            }
          }

          // #1325 PR 2d: a first payment whose Billing Event belongs to a
          // ProductSet is what activates that version — the trusted
          // confirmation, never the return from the hosted page. The commit
          // supersedes the previous Active version, replaces its obsolete future
          // Scheduled events and generates the new version's, in this one
          // transaction, and is idempotent: a duplicate delivery finds the set
          // already `active` and only tops up.
          if (pr.billing_event_id != null) {
            const { rows: owner } = await tx.query<{ product_set_id: number | null }>(
              'SELECT product_set_id FROM billing_events WHERE id = ? AND gym_id = ?',
              [pr.billing_event_id, pr.gym_id],
            );
            if (owner[0]?.product_set_id != null) {
              const activated = await activateWithEvents(tx, {
                gymId: pr.gym_id, productSetId: Number(owner[0].product_set_id),
                today: new Date().toISOString().slice(0, 10),
              });
              if (activated.kind !== 'ok') {
                req.log.error(
                  { orderId: payload.orderId, productSetId: owner[0].product_set_id, outcome: activated.kind },
                  'Payment webhook: a paid ProductSet could not be activated',
                );
              }
            }
          }
        });

        req.log.info({ orderId: payload.orderId, paymentRequestId: pr.id }, 'Payment webhook: completed');
      } else if (payload.status === 'failed' || payload.status === 'expired') {
        await db.query(
          `UPDATE payment_requests SET status = ?, provider_ref = ?, provider_status = ? WHERE id = ?`,
          [payload.status, payload.providerRef, payload.providerStatus ?? null, pr.id],
        );
        // #1121 stage 2: a purchase nobody paid for is `cancelled` rather than
        // left pending — §6's "failed/cancelled payments do not create a
        // completed purchase" in one direction, and in the other the thing that
        // frees the pending key so the member can try again.
        if (pr.source === PRODUCT_PURCHASE_SOURCE) {
          await cancelProductPurchase(db, pr.gym_id, pr.id);
        }
        req.log.info({ orderId: payload.orderId, status: payload.status }, 'Payment webhook: terminal non-success status');
      } else {
        // 'pending' is an intermediate status (Monei's AUTHORIZED/PENDING/
        // PROCESSING all map here) — not terminal. Leaving payment_requests
        // untouched keeps it eligible for the eventual completed/failed/
        // expired webhook: the guard above skips any row whose status isn't
        // 'pending', so flipping it here on an intermediate event would
        // permanently strand the row before the real outcome arrives.
        req.log.info({ orderId: payload.orderId, status: payload.status }, 'Payment webhook: intermediate status, no update');
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      req.log.error({ orderId: payload.orderId, err: (err as Error).message }, 'Payment webhook processing error');
      return res.status(500).json({ error: 'Processing failed' });
    }
  },
);
