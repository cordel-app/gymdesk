import crypto from 'crypto';
import { db, type Tx } from '../infra/db';
import { getPaymentProvider } from '../payments';
import {
  CARD_UPDATE_SOURCE,
  cardRemovalBlock,
  describeStoredCard,
  withPurposeParam,
  type RemovalBlockReason,
  type StoredCard,
  type StoredCardRow,
} from '../domain/storedCards';

/**
 * #788: creating a card replacement and reading back the card on file. Shared by
 * the member's own routes (`/me/payment-method`) and the staff router
 * (`/payment-methods`), so "replace this member's card" has one implementation
 * and the two surfaces cannot drift — the staff action is the same request the
 * member would raise, handed over as a link.
 */

export interface CardUpdateRequest {
  id: number;
  checkoutUrl: string;
}

export interface CreateCardUpdateInput {
  gymId: string;
  memberId: number;
  memberEmail: string;
  /**
   * The assignment the row hangs off. `payment_requests.user_membership_id` is
   * NOT NULL and the hosted page joins it for the gym and plan it renders, so a
   * card update names one even though the card belongs to the member rather than
   * to any one assignment — `resolveCardUpdateMembership()` picks it.
   */
  userMembershipId: number;
  /** Clerk user id of the staff member who raised it; null when the member did. */
  initiatedBy: string | null;
  /**
   * Stamped when the member themselves went through the consent checkbox on the
   * hosted page's flow, exactly as a customer-initiated payment does. A staff
   * member sending the link does not consent on the member's behalf — the member
   * still ticks the box on the page before the card widget is enabled.
   */
  stampConsent: boolean;
}

/**
 * The assignment a card update is recorded against: an `active` one first (the
 * card exists to pay for it), else the most recent of any status, because a
 * member whose membership lapsed may still be tidying up their card. `null`
 * when the member has no assignment at all, which the callers answer as a 400 —
 * there is no `payment_requests` row to write without one, and a member with no
 * assignment has no recurring charge to protect.
 */
export async function resolveCardUpdateMembership(
  gymId: string,
  memberId: number,
): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT um.id
       FROM user_memberships um
      WHERE um.gym_id = ? AND um.member_id = ?
      ORDER BY (um.status = 'active') DESC, um.starts_at DESC, um.id DESC
      LIMIT 1`,
    [gymId, memberId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Creates the provider-side verification and the `payment_requests` row that
 * carries its page token.
 *
 * The amount is not a parameter and not zero-by-convention: the provider call is
 * `createCardVerificationRequest()`, which takes no amount at all, so this path
 * cannot charge the member however it is called. The row's own `amount` is
 * `0.00` because the column is NOT NULL, and its `charge_type_id` is NULL
 * (migration 195) because a verification bills nothing.
 */
export async function createCardUpdateRequest(
  input: CreateCardUpdateInput,
): Promise<CardUpdateRequest> {
  const orderId = crypto.randomUUID();
  const pageToken = crypto.randomUUID();
  const pageTokenExpires = new Date(Date.now() + 10 * 60 * 1000);

  const provider = getPaymentProvider();
  const result = await provider.createCardVerificationRequest({
    orderId,
    currency: 'EUR',
    description: 'Card verification',
    memberEmail: input.memberEmail,
    // The member app's return page needs to tell a replaced card from a paid
    // fee: both land on PAYMENT_OK_URL, and only one of them has a payment to
    // report.
    okUrl: withPurposeParam(process.env.PAYMENT_OK_URL ?? '', 'card_update'),
    koUrl: withPurposeParam(process.env.PAYMENT_KO_URL ?? '', 'card_update'),
    notificationUrl: process.env.PAYMENT_NOTIFICATION_URL ?? '',
  });

  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, provider_ref, page_token, page_token_expires,
        consent_given_at, initiated_by, source)
     VALUES (?, ?, ?, '0.00', 'EUR', NULL, 'pending', 'monei', ?, ?, ?, ?, ${
       input.stampConsent ? 'UTC_TIMESTAMP()' : 'NULL'
     }, ?, '${CARD_UPDATE_SOURCE}')`,
    [
      input.gymId, input.userMembershipId, input.memberId,
      orderId, result.providerOrderId, pageToken, pageTokenExpires,
      input.initiatedBy,
    ],
  );

  const checkoutUrl = `${process.env.PAYMENT_PAGE_URL ?? 'https://pay.vdicube.com'}/checkout?token=${pageToken}`;
  return { id: insertId, checkoutUrl };
}

/** The card on file, without the token that can charge it. */
export async function loadStoredCard(
  gymId: string,
  memberId: number,
  conn: Pick<typeof db, 'query'> | Tx = db,
): Promise<StoredCard | null> {
  // `payment_methods`' unique key is (gym_id, member_id, provider), so a member
  // could in principle hold a row per provider. Only `monei` exists today, but an
  // unordered LIMIT 1 would make *which* card the screens show arbitrary the day a
  // second adapter lands — so the most recently stored one wins, deterministically.
  const { rows } = await conn.query<StoredCardRow>(
    `SELECT provider, card_brand, card_last4, created_at, updated_at
       FROM payment_methods
      WHERE gym_id = ? AND member_id = ?
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
      LIMIT 1`,
    [gymId, memberId],
  );
  return describeStoredCard(rows[0]);
}

export interface CardUpdateAttempt {
  id: number;
  status: string;
  created_at: string | Date;
  completed_at: string | Date | null;
}

/**
 * The member's most recent card replacement attempt. The member app's return
 * page polls it: a card update writes no Billing Event and no payment, so
 * "did it work?" has nothing else to read.
 */
export async function loadLatestCardUpdate(
  gymId: string,
  memberId: number,
): Promise<CardUpdateAttempt | null> {
  const { rows } = await db.query<CardUpdateAttempt>(
    `SELECT id, status, created_at, completed_at
       FROM payment_requests
      WHERE gym_id = ? AND member_id = ? AND source = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [gymId, memberId, CARD_UPDATE_SOURCE],
  );
  return rows[0] ?? null;
}

/** `null` when the member may remove their card — see `cardRemovalBlock()`. */
export async function loadCardRemovalBlock(
  gymId: string,
  memberId: number,
): Promise<RemovalBlockReason | null> {
  const { rows } = await db.query<{ status: string; next_billing_date: string | Date | null }>(
    `SELECT status, next_billing_date
       FROM user_memberships
      WHERE gym_id = ? AND member_id = ?`,
    [gymId, memberId],
  );
  // #1325: a plan a ProductSet bills has no `next_billing_date` on its
  // assignment; what is scheduled to be charged is the set's persisted events.
  // Any scheduled event, or a failed one still owed, of a version the member
  // owns makes the card billable exactly as a legacy next billing date did.
  const { rows: scheduled } = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM billing_events be JOIN product_sets ps ON ps.id = be.product_set_id
      WHERE be.gym_id = ? AND ps.owner_member_id = ? AND ps.status = 'active'
        AND (be.is_scheduled = 1 OR (be.event_type = 'failed_billing'
             AND NOT EXISTS (SELECT 1 FROM payment_requests pr
                              WHERE pr.billing_event_id = be.id AND pr.status = 'completed')))`,
    [gymId, memberId],
  );
  const owedByProductSet = Number(scheduled[0]?.n ?? 0) > 0;
  return cardRemovalBlock(owedByProductSet ? [...rows, { status: 'active', next_billing_date: new Date() }] : rows);
}
