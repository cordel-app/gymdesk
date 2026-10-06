import crypto from 'crypto';
import { db, type Tx } from '../infra/db';
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';

/**
 * #1108 stage 2 — the one place a **Membership Fee** payment request is raised.
 *
 * Three routes had a copy of this each: the staff `POST /payment-requests`, the
 * member's own `POST /me/payment-requests`, and now
 * `POST /user-memberships/:id/save-and-pay`. They differ only in who initiated
 * the payment, so what the provider is told, how long the hosted page's token
 * lives and what the `payment_requests` row says are answered here and the
 * initiator is a parameter.
 *
 * Why it is two functions and not one: the provider call is a network round trip
 * and the INSERT belongs in the caller's transaction. Save & Pay has to write the
 * request and lock the assignment together, so it calls the provider first (with
 * nothing yet written, so a provider failure changes nothing at all) and then
 * does both writes under one transaction. The two older routes call them in
 * sequence on `db`, which is exactly what they did before.
 *
 * The amount crosses the provider boundary in **minor units** and stays a decimal
 * number of euros on our side (CLAUDE.md's rule, `toMinorUnits()`): that
 * conversion lives here now, so a fourth caller cannot pass euros to a provider
 * that expects cents.
 */

/** How long the hosted page's `page_token` may be opened for. */
export const PAGE_TOKEN_TTL_MS = 10 * 60 * 1000;

/** What the provider is told this charge is for. */
const MEMBERSHIP_FEE_DESCRIPTION = 'Membership fee';

/** The charge type every Membership Fee payment is recorded under. */
export async function membershipFeeChargeTypeId(): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

/** The checkout link the member opens. Built from the one configured origin. */
export function checkoutUrlForToken(pageToken: string): string {
  const base = process.env.PAYMENT_PAGE_URL ?? 'https://pay.vdicube.com';
  return `${base}/checkout?token=${pageToken}`;
}

/** A provider order that exists but has no `payment_requests` row yet. */
export interface MembershipFeeProviderOrder {
  orderId: string;
  providerOrderId: string;
  pageToken: string;
  pageTokenExpires: Date;
}

/**
 * Ask the provider for a hosted payment for this fee.
 *
 * Nothing is written, so a provider that throws or never answers leaves the
 * database exactly as it was — which is what lets Save & Pay promise that a
 * failed charge leaves the Draft a Draft.
 */
export async function createMembershipFeeProviderOrder(args: {
  fee: number;
  memberEmail: string;
}): Promise<MembershipFeeProviderOrder> {
  const orderId = crypto.randomUUID();
  const pageToken = crypto.randomUUID();
  const pageTokenExpires = new Date(Date.now() + PAGE_TOKEN_TTL_MS);
  const result = await getPaymentProvider().createPaymentRequest({
    orderId,
    amount: toMinorUnits(args.fee),
    currency: 'EUR',
    description: MEMBERSHIP_FEE_DESCRIPTION,
    memberEmail: args.memberEmail,
    okUrl: process.env.PAYMENT_OK_URL ?? '',
    koUrl: process.env.PAYMENT_KO_URL ?? '',
    notificationUrl: process.env.PAYMENT_NOTIFICATION_URL ?? '',
  });
  return { orderId, providerOrderId: result.providerOrderId, pageToken, pageTokenExpires };
}

/**
 * Who raised the payment, which is the only thing the three callers disagree
 * about.
 *
 * `staff` stamps `initiated_by` and `source = 'admin'`; `member` stamps
 * `consent_given_at` and `source = 'customer'`, because a member clicking Pay
 * *is* the consent and a staff member clicking Save & Pay is not theirs to give.
 */
export type PaymentInitiator =
  | { kind: 'staff'; userId: string }
  | { kind: 'member' };

/** Write the `payment_requests` row for a provider order already created. */
export async function insertMembershipFeePaymentRequest(
  handle: Tx | typeof db,
  args: {
    gymId: string;
    userMembershipId: number;
    memberId: number;
    fee: number;
    chargeTypeId: number;
    order: MembershipFeeProviderOrder;
    initiator: PaymentInitiator;
  },
): Promise<{ id: number; checkoutUrl: string }> {
  const staff = args.initiator.kind === 'staff';
  const { insertId } = await handle.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, provider_ref, page_token, page_token_expires,
        ${staff ? 'initiated_by' : 'consent_given_at'}, source)
     VALUES (?, ?, ?, ?, 'EUR', ?, 'pending', 'monei', ?, ?, ?, ?, ${staff ? '?' : 'UTC_TIMESTAMP()'}, ?)`,
    [
      args.gymId, args.userMembershipId, args.memberId, args.fee.toFixed(2), args.chargeTypeId,
      args.order.orderId, args.order.providerOrderId,
      args.order.pageToken, args.order.pageTokenExpires,
      ...(staff ? [(args.initiator as { kind: 'staff'; userId: string }).userId] : []),
      staff ? 'admin' : 'customer',
    ],
  );
  return { id: insertId as number, checkoutUrl: checkoutUrlForToken(args.order.pageToken) };
}
