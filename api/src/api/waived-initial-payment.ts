/**
 * #3284 stage 4 — committing a cart whose Initial Payment staff waived down to zero.
 *
 * A waiver may now take the whole Initial Payment to €0.00 (owner, 25 Nov). Such a cart owes
 * nothing, so it is committed by the free activation (`POST /product-sets/:id/activate`), but it is
 * not a free cart: its first period was priced and then waived. So, in one transaction, under the
 * set's row lock and with the charge re-priced there:
 *  - the initial `payment_recorded` Billing Event is written with every line of the charge (the
 *    waived ones at €0.00 with their `initial_payment_waive` reason), through the one writer
 *    `ensureInitialEvent()`, which also links the cart's purchases to it;
 *  - a completed `waive` attempt of €0.00 settles it (no provider call, nothing collected);
 *  - the version is activated (`activateWithEvents()`), whose obligations skip the periods that
 *    initial event covers, so a waived first period is never charged as a scheduled obligation.
 */
import type { Tx } from '../infra/db';
import { activateWithEvents } from './product-set-configuration';
import { commitCharge, ensureInitialEvent } from './product-set-checkout';
import { recordPaymentAttempt } from './payment-attempt';
import { todayUtc } from '../domain/billingEventSimulation';
import type { InitialCharge } from './product-set-checkout';

/** Whether a charge owes nothing only because staff waived its lines. */
export function isWaivedToZero(charge: Pick<InitialCharge, 'amount' | 'lines'> | null | undefined): boolean {
  return charge != null && !(charge.amount > 0) && charge.lines.some((l) => l.waived === true);
}

export type WaivedCommitOutcome =
  | { kind: 'ok'; billingEventId: number; eventsCreated: number }
  | { kind: 'not_committable'; status: string | null }
  | { kind: 'amount_changed'; amount: number }
  | { kind: string };

export async function commitWaivedInitialPayment(tx: Tx, input: {
  gymId: string; set: any; actor: string | null;
}): Promise<WaivedCommitOutcome> {
  const { gymId, set, actor } = input;
  const productSetId = Number(set.id);
  const { rows: locked } = await tx.query<{ status: string }>(
    'SELECT status FROM product_sets WHERE id = ? AND gym_id = ? FOR UPDATE', [productSetId, gymId]);
  if (locked[0]?.status !== 'in_cart') return { kind: 'not_committable', status: locked[0]?.status ?? null };

  // Re-priced under the lock: a change that landed after the caller's read is never committed as €0.
  const { startsAt, charge } = await commitCharge(gymId, set, tx);
  if (!charge || !isWaivedToZero(charge)) return { kind: 'amount_changed', amount: charge?.amount ?? 0 };

  const { rows: ct } = await tx.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  const chargeTypeId = ct[0]?.id ?? null;
  const memberId = Number(set.owner_member_id);
  const billingEventId = await ensureInitialEvent(tx, { gymId, productSetId, memberId, startsAt, charge, chargeTypeId, actor });

  const { rows: prev } = await tx.query<{ attempt: number }>(
    'SELECT attempt FROM payment_requests WHERE billing_event_id = ? FOR UPDATE', [billingEventId]);
  const attempt = prev.reduce((m, a) => Math.max(m, Number(a.attempt)), 0) + 1;
  const { insertId } = await tx.query(
    `INSERT INTO payment_requests
       (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider,
        provider_order, source, attempt, method, created_by, created_at, completed_at)
     VALUES (?, ?, 0, 'EUR', ?, ?, 'completed', 'monei', ?, 'manual', ?, 'waive', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [gymId, memberId, chargeTypeId, billingEventId, `PS-WAIVE-${productSetId}-${attempt}`, attempt, actor]);
  await recordPaymentAttempt(tx, insertId);
  await tx.query('UPDATE product_sets SET payment_request_id = ? WHERE id = ?', [insertId, productSetId]);

  const activated = await activateWithEvents(tx, { gymId, productSetId, today: todayUtc(), actor });
  if (activated.kind !== 'ok') throw Object.assign(new Error(activated.kind), { kind: activated.kind });
  return { kind: 'ok', billingEventId, eventsCreated: (activated as any).eventsCreated ?? 0 };
}
