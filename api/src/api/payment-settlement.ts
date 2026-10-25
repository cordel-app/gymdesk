import type { logger } from '../lib/logger';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { CARD_UPDATE_SOURCE } from '../domain/storedCards';
import { classifyProviderStatus, normaliseProviderStatus } from '../domain/providerPaymentStatus';
import { PRODUCT_PURCHASE_SOURCE } from '../domain/memberProductPurchase';
import { db, type Tx } from '../infra/db';
import { getPaymentProvider } from '../payments';
import type { WebhookPayload } from '../payments/types';
import { PENDING_PAYMENT_STATUS, commitAssignment } from './assignment-commit';
import { activeProductSetIdForMember, productSetIdForAssignment } from './product-set-bridge';
import { activateWithEvents } from './product-set-configuration';
import { cancelProductPurchase, completeProductPurchase } from './me-products';

/**
 * #2087: the one place a provider's answer about a payment becomes our rows.
 *
 * Three callers hand it the provider's own payload and nothing else:
 *
 *  - `POST /webhooks/payment` — MONEI's signed callback (`via: 'webhook'`);
 *  - `POST /payment-page/payments/:paymentId/confirm` — the hosted page, once
 *    `confirmPayment()` resolves, asks the API to read the payment back from
 *    MONEI (`via: 'confirm'`);
 *  - `POST /billing/cleanup` — before an opened request is written off
 *    (`via: 'cleanup'`).
 *
 * The browser's own status never reaches this function: the confirmation is a
 * prompt to ask MONEI, and MONEI's answer is what settles.
 *
 * Whichever caller arrives first settles; the others find the row `completed`
 * and change nothing. The row is read `FOR UPDATE` inside the transaction that
 * settles it, so a webhook and a confirmation landing together cannot both pass
 * the `settleable` check (they could while the read was unlocked and outside the
 * transaction, and the branch that writes a missing Billing Event would have
 * written two).
 */

export type SettleVia = 'webhook' | 'confirm' | 'cleanup';

export type SettleOutcome =
  /** No `payment_requests` row carries this order id. */
  | { kind: 'no_request' }
  /** The row was already terminal and this payload may not reopen it. */
  | { kind: 'already_processed'; status: string }
  /** The row now holds this outcome. */
  | { kind: 'settled'; status: 'completed' | 'failed' | 'expired' }
  /** The provider has no outcome yet; nothing was written. */
  | { kind: 'intermediate' };

type Log = Pick<typeof logger, 'info' | 'warn' | 'error'>;

interface RequestRow {
  id: number;
  gym_id: string;
  user_membership_id: number | null;
  member_id: number;
  charge_type_id: number | null;
  amount: string;
  status: string;
  source: string;
  billing_event_id: number | null;
}

/**
 * A Billing Event is paid once, so when one attempt on it completes, every other
 * attempt still `pending` on that event is closed as `expired`. Each Pay now
 * raises a new attempt on the same initial event, and until this the ones a
 * member opened and abandoned stayed `pending` after the event was paid: My
 * Products kept showing "You have a pending payment" with a Pay now that would
 * have charged a paid cycle again. An expired attempt still accepts a
 * `completed` payload (#789 — the provider is the source of truth about money),
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

async function storeCard(tx: Tx, pr: RequestRow, payload: WebhookPayload): Promise<void> {
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

export async function settlePaymentRequest(
  payload: WebhookPayload,
  opts: { via: SettleVia; log: Log },
): Promise<SettleOutcome> {
  const { via, log } = opts;
  const ctx = { via, orderId: payload.orderId };

  return db.transaction(async (tx): Promise<SettleOutcome> => {
    const { rows } = await tx.query<RequestRow>(
      `SELECT id, gym_id, user_membership_id, member_id, charge_type_id, amount, status, source, billing_event_id
         FROM payment_requests WHERE provider_order = ? FOR UPDATE`,
      [payload.orderId],
    );

    if (!rows[0]) {
      log.warn(ctx, 'Payment settlement: no matching payment_request');
      return { kind: 'no_request' };
    }

    const pr = rows[0];

    // #789 — the provider is the source of truth about money. A `pending` row
    // is the normal case, but an `expired` one still accepts a `completed`
    // payload: cleanup can expire a request whose page was opened, and MONEI
    // can retry a webhook after a transient 5xx on our side, yet neither is
    // worth losing a charge over. Deliberately narrow: only `completed` may
    // revive a terminal row, a `failed`/`expired` payload on a terminal row
    // changes nothing, and an already-`completed` row is always skipped — which
    // is what keeps every caller idempotent.
    const settleable =
      pr.status === 'pending' || (pr.status === 'expired' && payload.status === 'completed');

    if (!settleable) {
      log.info({ ...ctx, status: pr.status }, 'Payment settlement: already processed, skipping');
      return { kind: 'already_processed', status: pr.status };
    }

    if (payload.status === 'completed' && pr.source === CARD_UPDATE_SOURCE) {
      // #788: a card replacement is a zero-amount verification, not a payment.
      // It settles no cycle, so it writes no Billing Event and clears none of
      // #785's dunning counters — the rejection that started the member
      // replacing their card is still owed. All it does is store the new token.
      await tx.query(
        `UPDATE payment_requests
         SET status = 'completed', provider_ref = ?, completed_at = UTC_TIMESTAMP(),
             modified_at = UTC_TIMESTAMP(), modified_by = ?
         WHERE id = ?`,
        [payload.providerRef, SYSTEM_ACTOR, pr.id],
      );

      if (payload.paymentToken && payload.sequenceId) {
        await storeCard(tx, pr, payload);
      } else {
        // Nothing reusable to store, so the old card still stands. Logged
        // rather than failed: asking again cannot conjure a token.
        log.warn(ctx, 'Payment settlement: card update completed without a token');
      }

      log.info({ ...ctx, paymentRequestId: pr.id }, 'Payment settlement: card updated');
      return { kind: 'settled', status: 'completed' };
    }

    if (payload.status === 'completed' && pr.source === PRODUCT_PURCHASE_SOURCE) {
      // #1121 stage 2: a Product the member bought settles no membership
      // cycle — it stamps no billing date, clears no dunning counter and
      // stores no card (a one-off authorises one charge).
      await tx.query(
        `UPDATE payment_requests
         SET status = 'completed', provider_ref = ?, provider_status = ?, completed_at = UTC_TIMESTAMP(),
             modified_at = UTC_TIMESTAMP(), modified_by = ?
         WHERE id = ?`,
        [payload.providerRef, payload.providerStatus ?? 'SUCCEEDED', SYSTEM_ACTOR, pr.id],
      );

      // The purchase's `product_purchase` Billing Event was written with the
      // request (#1325 PR 2); a request that predates that gets one here so
      // the ledger still records the money that arrived.
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
        log.warn(
          { ...ctx, paymentRequestId: pr.id },
          'Payment settlement: product purchase payment with no pending purchase to complete',
        );
      }

      log.info({ ...ctx, paymentRequestId: pr.id }, 'Payment settlement: product purchase completed');
      return { kind: 'settled', status: 'completed' };
    }

    if (payload.status === 'completed') {
      if (pr.status === 'expired') {
        log.warn({ ...ctx, paymentRequestId: pr.id }, 'Payment settlement: completing a request cleanup had already expired');
      }

      await tx.query(
        `UPDATE payment_requests
         SET status = 'completed', provider_ref = ?, provider_status = ?, completed_at = UTC_TIMESTAMP(),
             modified_at = UTC_TIMESTAMP(), modified_by = ?
         WHERE id = ?`,
        [payload.providerRef, payload.providerStatus ?? 'SUCCEEDED', SYSTEM_ACTOR, pr.id],
      );
      await closeSiblingAttempts(tx, pr.gym_id, pr.billing_event_id, pr.id);

      if (payload.paymentToken && payload.sequenceId) {
        await storeCard(tx, pr, payload);
      }

      // #1108 stage 2: a first payment on a Pending Payment row activates it,
      // with the replacement confirmed at Save & Pay taken as given (a paid-up
      // member must not be left planless). A row in any other status is
      // untouched, so a renewal paid through a checkout link changes nothing.
      if (pr.user_membership_id != null) {
        const committed = await commitAssignment(tx, {
          gymId: pr.gym_id, userMembershipId: pr.user_membership_id,
          fromStatuses: [PENDING_PAYMENT_STATUS], confirm: true,
          source: 'provider', actorUserId: null, actor: SYSTEM_ACTOR,
        });
        if (committed.kind !== 'committed' && committed.kind !== 'not_committable') {
          log.error(
            { ...ctx, userMembershipId: pr.user_membership_id, outcome: committed },
            'Payment settlement: a paid membership pending payment could not be activated',
          );
        }
      }

      if (pr.billing_event_id == null) {
        // A request raised with no event (none since #1325 PR 3b) still records
        // the money, against the ProductSet the assignment or the member holds.
        const setId = pr.user_membership_id != null
          ? await productSetIdForAssignment(tx, pr.gym_id, pr.user_membership_id)
          : null;
        const ownerSetId = setId ?? (pr.member_id != null ? await activeProductSetIdForMember(tx, pr.gym_id, pr.member_id) : null);
        if (ownerSetId == null) {
          // The request stays completed (the money is the provider's fact); the
          // missing ledger row is an error to reconcile, never a reason to fail.
          log.error({ ...ctx, paymentRequestId: pr.id }, 'Payment settlement: completed payment with no ProductSet to record it against');
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
      // ProductSet activates that version — the provider's confirmation, never
      // a status the browser sent. Idempotent: a repeat finds the set active.
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
              { ...ctx, productSetId: owner[0].product_set_id, outcome: activated.kind },
              'Payment settlement: a paid ProductSet could not be activated',
            );
          }
        }
      }

      log.info({ ...ctx, paymentRequestId: pr.id }, 'Payment settlement: completed');
      return { kind: 'settled', status: 'completed' };
    }

    if (payload.status === 'failed' || payload.status === 'expired') {
      await tx.query(
        `UPDATE payment_requests
            SET status = ?, provider_ref = ?, provider_status = ?,
                modified_at = UTC_TIMESTAMP(), modified_by = ?
          WHERE id = ?`,
        [payload.status, payload.providerRef, payload.providerStatus ?? null, SYSTEM_ACTOR, pr.id],
      );
      // #1121 stage 2: a purchase nobody paid for is `cancelled`, which frees
      // the pending key so the member can try again.
      if (pr.source === PRODUCT_PURCHASE_SOURCE) {
        await cancelProductPurchase(tx, pr.gym_id, pr.id);
      }
      log.info({ ...ctx, status: payload.status }, 'Payment settlement: terminal non-success status');
      return { kind: 'settled', status: payload.status };
    }

    // 'pending' is intermediate (MONEI's AUTHORIZED/PENDING/PROCESSING). The
    // row stays eligible for the real outcome; flipping it now would strand it.
    log.info({ ...ctx, status: payload.status }, 'Payment settlement: intermediate status, no update');
    return { kind: 'intermediate' };
  });
}

/**
 * #2087: settles from a payment the API **read back** from the provider (the
 * confirmation and the cleanup), never from a delivery. The read is judged by
 * the provider's raw status through `classifyProviderStatus()` rather than the
 * adapter's four-value map, which defaults an unrecognised status — and
 * `PENDING_PROCESSING` — to `failed`: asking MONEI a moment after the card was
 * submitted is exactly when an in-flight status is likely, and recording it as
 * a failure would turn a payment still settling into one that failed. Only a
 * definitive answer moves the row: `settled` completes it, `unsuccessful`
 * fails (or expires) it, and everything else — in flight, refunded, unknown —
 * writes nothing and is reported as `intermediate`.
 */
export async function settleFromProviderLookup(
  payload: WebhookPayload,
  opts: { via: Exclude<SettleVia, 'webhook'>; log: Log },
): Promise<SettleOutcome> {
  const cls = classifyProviderStatus(payload.providerStatus ?? null);
  if (cls === 'settled') return settlePaymentRequest({ ...payload, status: 'completed' }, opts);
  if (cls === 'unsuccessful') {
    const status = normaliseProviderStatus(payload.providerStatus) === 'EXPIRED' ? 'expired' : 'failed';
    return settlePaymentRequest({ ...payload, status }, opts);
  }
  opts.log.info({ via: opts.via, orderId: payload.orderId, providerStatus: payload.providerStatus }, 'Payment settlement: provider reports no final outcome, nothing written');
  return { kind: 'intermediate' };
}

/** At most this many abandoned requests are looked up per cleanup run. */
export const RECONCILE_BATCH_SIZE = 200;

export interface ReconcileResult {
  /** Requests the provider's answer settled (completed, failed or expired). */
  reconciled: number;
  /** Requests the provider still reports with no outcome: cleanup expires them as before. */
  writeOff: number[];
}

/**
 * #2087: before `POST /billing/cleanup` writes off an opened request that sat
 * `pending` past the abandonment window, it asks the provider what happened.
 * A request the provider reports as settled is settled from that answer
 * (`via: 'cleanup'`) instead of being expired — the member who paid while the
 * webhook was lost is not turned into a member who did not pay. A request the
 * provider still reports pending (or answers for another order) is returned in
 * `writeOff`, so cleanup expires it exactly as before. A request the provider
 * could not be asked about is in neither list and stays `pending` for the next
 * run, as does anything past the batch.
 */
export async function reconcileAbandonedRequests(
  abandonedAfterHours: number,
  log: Log,
): Promise<ReconcileResult> {
  const { rows } = await db.query<{ id: number; provider_ref: string; provider_order: string }>(
    `SELECT id, provider_ref, provider_order
       FROM payment_requests
      WHERE status = 'pending'
        AND page_token IS NULL
        AND provider_ref IS NOT NULL
        AND page_token_expires < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)
      ORDER BY id
      LIMIT ${RECONCILE_BATCH_SIZE}`,
    [abandonedAfterHours],
  );

  const result: ReconcileResult = { reconciled: 0, writeOff: [] };
  if (rows.length === 0) return result;

  let provider;
  try {
    provider = getPaymentProvider();
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Payment reconcile: no payment provider configured');
    return result;
  }

  for (const row of rows) {
    let payload: WebhookPayload;
    try {
      payload = await provider.getPaymentStatus(row.provider_ref);
    } catch (err) {
      log.warn({ paymentRequestId: row.id, err: (err as Error).message }, 'Payment reconcile: provider lookup failed, retried next run');
      continue;
    }
    if (payload.orderId !== row.provider_order) {
      log.error({ paymentRequestId: row.id }, 'Payment reconcile: provider order id does not match the payment request');
      result.writeOff.push(row.id);
      continue;
    }
    const outcome = await settleFromProviderLookup(payload, { via: 'cleanup', log });
    if (outcome.kind === 'settled') result.reconciled += 1;
    else if (outcome.kind === 'intermediate') result.writeOff.push(row.id);
  }
  return result;
}
