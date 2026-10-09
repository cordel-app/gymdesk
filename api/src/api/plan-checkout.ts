import crypto from 'crypto';
import { db } from '../infra/db';
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';

/**
 * #1288 stage 1 — the checkout of a Membership Plan a member just saved.
 *
 * Save & Pay in the Members App does not stop at `pending_payment`: it writes
 * the **initial real Billing Event** and the payment request linked to it
 * before the member is sent to the hosted page, so the ledger already shows
 * the charge as pending (its status derives from its latest transaction,
 * `deriveBillingEventStatus()`) and the payment webhook settles that event
 * rather than appending a second one. Only this first charge is written: the
 * later ones are the nightly run's, priced from the frozen snapshot.
 *
 * `findOpenInitialEvent()` is what makes a retry safe — a second attempt to
 * pay the same row reuses the event instead of leaving a pending one behind.
 */

interface CheckoutInput {
  gymId: string;
  memberId: number;
  memberEmail: string;
  userMembershipId: number;
  /** Decimal euros, as `currentMembershipFee()` returns it. */
  fee: number;
}

/** The unpaid `payment_recorded` event of this assignment, if one is waiting. */
export async function findOpenInitialEvent(gymId: string, userMembershipId: number): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT be.id FROM billing_events be
      WHERE be.gym_id = ? AND be.user_membership_id = ? AND be.event_type = 'payment_recorded'
        AND NOT EXISTS (SELECT 1 FROM payment_requests pr
                         WHERE pr.billing_event_id = be.id AND pr.gym_id = be.gym_id AND pr.status = 'completed')
      ORDER BY be.id DESC LIMIT 1`,
    [gymId, userMembershipId],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export async function createPlanCheckout(input: CheckoutInput): Promise<{ id: number; checkoutUrl: string; billing_event_id: number }> {
  const { gymId, memberId, userMembershipId, fee } = input;
  const { rows: ctRows } = await db.query<{ id: number }>(
    `SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1`,
  );
  if (!ctRows[0]) throw Object.assign(new Error('charge_type membership_fee not configured'), { status: 500 });
  const chargeTypeId = ctRows[0].id;

  const orderId = crypto.randomUUID();
  const pageToken = crypto.randomUUID();
  const pageTokenExpires = new Date(Date.now() + 10 * 60 * 1000);
  const provider = getPaymentProvider();
  const result = await provider.createPaymentRequest({
    orderId,
    amount: toMinorUnits(fee),
    currency: 'EUR',
    description: 'Membership fee',
    memberEmail: input.memberEmail,
    okUrl: process.env.PAYMENT_OK_URL ?? '',
    koUrl: process.env.PAYMENT_KO_URL ?? '',
    notificationUrl: process.env.PAYMENT_NOTIFICATION_URL ?? '',
  });

  const out = await db.transaction(async (tx) => {
    let eventId = await findOpenInitialEventTx(tx, gymId, userMembershipId);
    if (eventId == null) {
      const { insertId } = await tx.query(
        `INSERT INTO billing_events
           (gym_id, user_membership_id, member_id, event_type, amount, charge_type_id, source, actor_user_id)
         VALUES (?, ?, ?, 'payment_recorded', ?, ?, 'customer', NULL)`,
        [gymId, userMembershipId, memberId, fee.toFixed(2), chargeTypeId],
      );
      eventId = Number(insertId);
    }
    const { insertId } = await tx.query(
      `INSERT INTO payment_requests
         (gym_id, user_membership_id, member_id, amount, currency, charge_type_id, billing_event_id,
          status, provider, provider_order, provider_ref, page_token, page_token_expires,
          consent_given_at, source)
       VALUES (?, ?, ?, ?, 'EUR', ?, ?, 'pending', 'monei', ?, ?, ?, ?, UTC_TIMESTAMP(), 'customer')`,
      [gymId, userMembershipId, memberId, fee.toFixed(2), chargeTypeId, eventId, orderId, result.providerOrderId, pageToken, pageTokenExpires],
    );
    return { id: Number(insertId), billing_event_id: eventId };
  });

  const checkoutUrl = `${process.env.PAYMENT_PAGE_URL ?? 'https://pay.vdicube.com'}/checkout?token=${pageToken}`;
  return { ...out, checkoutUrl };
}

async function findOpenInitialEventTx(tx: { query: typeof db.query }, gymId: string, userMembershipId: number): Promise<number | null> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT be.id FROM billing_events be
      WHERE be.gym_id = ? AND be.user_membership_id = ? AND be.event_type = 'payment_recorded'
        AND NOT EXISTS (SELECT 1 FROM payment_requests pr
                         WHERE pr.billing_event_id = be.id AND pr.gym_id = be.gym_id AND pr.status = 'completed')
      ORDER BY be.id DESC LIMIT 1 FOR UPDATE`,
    [gymId, userMembershipId],
  );
  return rows[0] ? Number(rows[0].id) : null;
}
