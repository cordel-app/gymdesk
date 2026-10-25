import { SYSTEM_ACTOR } from '../domain/auditActor';
import { db, type Tx } from '../infra/db';
import type { WebhookPayload } from '../payments/types';
import { PENDING_PAYMENT_STATUS, commitAssignment } from './assignment-commit';
import { activeProductSetIdForMember, productSetIdForAssignment } from './product-set-bridge';
import { activateWithEvents } from './product-set-configuration';
import { CARD_UPDATE_SOURCE } from '../domain/storedCards';
import { PRODUCT_PURCHASE_SOURCE } from '../domain/memberProductPurchase';
import { cancelProductPurchase, completeProductPurchase } from './me-products';

/**
 * #2087: the one place a payment request is settled from the provider's own
 * answer. Three callers hand it a payload: the webhook (`parseWebhook()`), the
 * hosted page's confirmation and the cleanup's reconciliation (both through
 * `getPaymentStatus()`). Nothing a browser sends reaches it. The request row is
 * read `FOR UPDATE` inside the transaction and `settleable` is decided under
 * that lock, so two deliveries racing on one payment settle it once.
 */
export type SettleVia = 'webhook' | 'confirm' | 'cleanup';

export interface SettleLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export type SettleOutcome =
  | { kind: 'no_request' }
  | { kind: 'skipped'; requestStatus: string }
  | { kind: 'intermediate'; requestStatus: string }
  | { kind: 'settled'; requestStatus: string };

/**
 * A Billing Event is paid once, so when one attempt on it completes, every other
 * attempt still `pending` on that event is closed as `expired`. Each Pay now
 * raises a new attempt on the same initial event, and until this the ones a
 * member opened and abandoned stayed `pending` after the event was paid: My
 * Products kept showing "You have a pending payment" with a Pay now that would
 * have charged a paid cycle again. An expired attempt still accepts a
 * `completed` webhook (#789 — the provider is the source of truth about money),
 * so closing one can never lose a payment that was in fact made.
 */
async function closeSiblingAttempts(
  tx: Tx,
  gymId: string,
  billingEventId: number | null,
  completedRequestId: number,
): Promise<void> {
  if (billingEventId == null) return;
  await tx.query(
    `UPDATE payment_requests
     SET status = 'expired', page_token = NULL, modified_at = UTC_TIMESTAMP(), modified_by = ?
     WHERE gym_id = ? AND billing_event_id = ? AND id <> ? AND status = 'pending'`,
    [SYSTEM_ACTOR, gymId, billingEventId, completedRequestId],
  );
}

export async function settlePaymentRequest(
  payload: WebhookPayload,
  opts: { via: SettleVia; log: SettleLogger },
): Promise<SettleOutcome> {
  const { via } = opts;
  const log: SettleLogger = {
    info: (o, m) => opts.log.info({ ...o, via }, m),
    warn: (o, m) => opts.log.warn({ ...o, via }, m),
    error: (o, m) => opts.log.error({ ...o, via }, m),
  };

  return db.transaction(async (tx): Promise<SettleOutcome> => {
    const { rows } = await tx.query<{
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
       FROM payment_requests WHERE provider_order = ? FOR UPDATE`,
      [payload.orderId],
    );

    if (!rows[0]) {
      log.warn({ orderId: payload.orderId }, 'Payment settle: no matching payment_request');
      return { kind: 'no_request' };
    }

    const pr = rows[0];

    // #789 — the provider is the source of truth about money. A `pending` row
    // is the normal case, but an `expired` one still accepts a `completed`
    // answer. Deliberately narrow: only `completed` may revive a terminal row,
    // and an already-`completed` row is always skipped, which is what keeps
    // settling idempotent under retries and under the webhook/confirm race.
    const settleable =
      pr.status === 'pending' || (pr.status === 'expired' && payload.status === 'completed');

    if (!settleable) {
      log.info({ orderId: payload.orderId, status: pr.status }, 'Payment settle: already processed, skipping');
      return { kind: 'skipped', requestStatus: pr.status };
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
      {
        await tx.query(
          `UPDATE payment_requests
           SET status = 'completed', provider_ref = ?, completed_at = UTC_TIMESTAMP(),
               modified_at = UTC_TIMESTAMP(), modified_by = ?
           WHERE id = ?`,
          [payload.providerRef, SYSTEM_ACTOR, pr.id],
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
          log.warn({ orderId: payload.orderId }, 'Payment settle: card update completed without a token');
        }
      }

      log.info({ orderId: payload.orderId, paymentRequestId: pr.id }, 'Payment settle: card updated');
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
      {
        await tx.query(
          `UPDATE payment_requests
           SET status = 'completed', provider_ref = ?, provider_status = ?, completed_at = UTC_TIMESTAMP(),
               modified_at = UTC_TIMESTAMP(), modified_by = ?
           WHERE id = ?`,
          [payload.providerRef, payload.providerStatus ?? 'SUCCEEDED', SYSTEM_ACTOR, pr.id],
        );

        // The purchase's `product_purchase` Billing Event was written with the
        // request (#1325 PR 2), so there is nothing to insert: the request
        // becoming `completed` is what moves the event's derived status to
        // paid. A request that predates that change has no event, and gets
        // one here so the ledger still records the money that arrived.
        if (pr.billing_event_id == null) {
          const { insertId: billingEventId } = await tx.query(
            `INSERT INTO billing_events
               (gym_id, member_id, event_type, amount, charge_type_id, source, created_by)
             VALUES (?, ?, 'product_purchase', ?, ?, 'provider', ?)`,
            [pr.gym_id, pr.member_id, pr.amount, pr.charge_type_id, SYSTEM_ACTOR],
          );
          await tx.query(
            `UPDATE payment_requests SET billing_event_id = ?, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ?`,
            [billingEventId, SYSTEM_ACTOR, pr.id],
          );
        }

        await closeSiblingAttempts(tx, pr.gym_id, pr.billing_event_id, pr.id);
        const completed = await completeProductPurchase(tx, pr.gym_id, pr.id);
        if (completed === 0) {
          // The payment is real either way, so the Billing Event above
          // stands; what is missing is a purchase row to mark, which means
          // one of the two was already completed or was never written.
          log.warn(
            { orderId: payload.orderId, paymentRequestId: pr.id },
            'Payment settle: product purchase payment with no pending purchase to complete',
          );
        }
      }

      log.info(
        { orderId: payload.orderId, paymentRequestId: pr.id },
        'Payment settle: product purchase completed',
      );
    } else if (payload.status === 'completed') {
      if (pr.status === 'expired') {
        log.warn(
          { orderId: payload.orderId, paymentRequestId: pr.id },
          'Payment settle: completing a request cleanup had already expired',
        );
      }
      {
        await tx.query(
          `UPDATE payment_requests
           SET status = 'completed', provider_ref = ?, provider_status = ?, completed_at = UTC_TIMESTAMP(),
               modified_at = UTC_TIMESTAMP(), modified_by = ?
           WHERE id = ?`,
          [payload.providerRef, payload.providerStatus ?? 'SUCCEEDED', SYSTEM_ACTOR, pr.id],
        );
        await closeSiblingAttempts(tx, pr.gym_id, pr.billing_event_id, pr.id);

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
            source: 'provider', actorUserId: null, actor: SYSTEM_ACTOR,
          });
          // `not_committable` is the ordinary case — a renewal paid on an
          // already-active row. Anything else is a paid row left pending,
          // which staff must resolve by hand, so it is an error rather than
          // a warning.
          if (committed.kind !== 'committed' && committed.kind !== 'not_committable') {
            log.error(
              { orderId: payload.orderId, userMembershipId: pr.user_membership_id, outcome: committed },
              'Payment settle: a paid membership pending payment could not be activated',
            );
          }
        }

        if (pr.billing_event_id == null) {
          // A request raised with no event (none since #1325 PR 3b) still
          // records the money, against the ProductSet the assignment or the
          // member holds — a ledger row with no set is not written any more.
          const setId = pr.user_membership_id != null
            ? await productSetIdForAssignment(tx, pr.gym_id, pr.user_membership_id)
            : null;
          const ownerSetId = setId ?? (pr.member_id != null ? await activeProductSetIdForMember(tx, pr.gym_id, pr.member_id) : null);
          if (ownerSetId == null) {
            // The request stays completed (the money is the provider's fact);
            // the missing ledger row is an error to reconcile, never a reason to
            // fail the delivery and have Monei retry it for ever.
            log.error(
              { orderId: payload.orderId, paymentRequestId: pr.id },
              'Payment settle: completed payment with no ProductSet to record it against',
            );
          } else {
            const { insertId: billingEventId } = await tx.query(
              `INSERT INTO billing_events
                 (gym_id, product_set_id, member_id, event_type, amount, charge_type_id, source, created_by)
               VALUES (?, ?, ?, 'payment_recorded', ?, ?, 'provider', ?)`,
              [pr.gym_id, ownerSetId, pr.member_id, pr.amount, pr.charge_type_id, SYSTEM_ACTOR],
            );
            await tx.query(
              `UPDATE payment_requests SET billing_event_id = ?, modified_at = UTC_TIMESTAMP(), modified_by = ? WHERE id = ?`,
              [billingEventId, SYSTEM_ACTOR, pr.id],
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
              today: new Date().toISOString().slice(0, 10), actor: SYSTEM_ACTOR,
            });
            if (activated.kind !== 'ok') {
              log.error(
                { orderId: payload.orderId, productSetId: owner[0].product_set_id, outcome: activated.kind },
                'Payment settle: a paid ProductSet could not be activated',
              );
            }
          }
        }
      }

      log.info({ orderId: payload.orderId, paymentRequestId: pr.id }, 'Payment settle: completed');
    } else if (payload.status === 'failed' || payload.status === 'expired') {
      await tx.query(
        `UPDATE payment_requests
            SET status = ?, provider_ref = ?, provider_status = ?,
                modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ?`,
        [payload.status, payload.providerRef, payload.providerStatus ?? null, SYSTEM_ACTOR, pr.id],
      );
      // #1121 stage 2: a purchase nobody paid for is `cancelled` rather than
      // left pending — §6's "failed/cancelled payments do not create a
      // completed purchase" in one direction, and in the other the thing that
      // frees the pending key so the member can try again.
      if (pr.source === PRODUCT_PURCHASE_SOURCE) {
        await cancelProductPurchase(tx, pr.gym_id, pr.id);
      }
      log.info({ orderId: payload.orderId, status: payload.status }, 'Payment settle: terminal non-success status');
    } else {
      // 'pending' is an intermediate status (Monei's AUTHORIZED/PENDING/
      // PROCESSING all map here) — not terminal. Leaving payment_requests
      // untouched keeps it eligible for the eventual completed/failed/
      // expired webhook: the guard above skips any row whose status isn't
      // 'pending', so flipping it here on an intermediate event would
      // permanently strand the row before the real outcome arrives.
      log.info({ orderId: payload.orderId, status: payload.status }, 'Payment settle: intermediate status, no update');
      return { kind: 'intermediate', requestStatus: pr.status };
    }


    return { kind: 'settled', requestStatus: payload.status };
  });
}
