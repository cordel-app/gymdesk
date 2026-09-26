/**
 * #788: the stored card a member's recurring charges are taken from
 * (`payment_methods`, one row per member and gym) and the rules around
 * replacing or removing it. Pure — no DB, no provider — so both the member
 * routes (`/me/payment-method`) and the staff router (`/payment-methods`)
 * answer from one implementation and it can be unit-tested on its own.
 */

/**
 * `payment_requests.source` of a card verification (migration 195). A row
 * carrying it is **not** a charge: it has no charge type, an amount of 0, and
 * the webhook's card-update branch writes no Billing Event for it. Every
 * financial surface excludes it — the Members list's `payment_status`, the
 * staff request list and the member's own payment history — so a card
 * replacement can never read as a payment.
 */
export const CARD_UPDATE_SOURCE = 'card_update';

/**
 * What the hosted payment page is being opened for. It reaches the page in the
 * token response, and the member app's return page in a `purpose` query
 * parameter, because both render a card replacement differently from a charge
 * (no amount, a different consent sentence, "save card" instead of "pay now").
 */
export type PaymentPagePurpose = 'membership_fee' | 'card_update';

/** Assignment statuses the nightly run can still bill, or resume and bill. */
const BILLABLE_STATUSES = new Set(['active', 'paused']);

export type RemovalBlockReason = 'billable_membership';

export interface AssignmentBillingState {
  status: string;
  next_billing_date: string | Date | null;
}

/**
 * Why this member may not remove their stored card, or `null` when they may.
 *
 * The product decision #788 §3 asked for: removal is allowed only once nothing
 * is scheduled to be charged any more. Removing a card under a live contract
 * stops the nightly run silently — it skips an assignment with no
 * `payment_methods` row and writes nothing at all — and the surfaces that would
 * make that visible to the staff (#779) do not exist yet, so the member would
 * simply stop paying with nobody the wiser. Replacing a card, which is the
 * whole point of this ticket, stays available in every state; a member who
 * wants to stop paying cancels the membership, which is a conversation with the
 * gym rather than a silent database change.
 */
export function cardRemovalBlock(assignments: AssignmentBillingState[]): RemovalBlockReason | null {
  const billable = assignments.some(
    (a) => BILLABLE_STATUSES.has(a.status) && a.next_billing_date != null,
  );
  return billable ? 'billable_membership' : null;
}

export interface StoredCardRow {
  provider: string;
  card_brand: string | null;
  card_last4: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

export interface StoredCard {
  provider: string;
  card_brand: string | null;
  card_last4: string | null;
  /** When the card *on file now* was stored — the last upsert, else the row's own age. */
  since: string | Date | null;
}

/**
 * Never returns the `payment_token` or `sequence_id`: they are credentials for
 * charging this member, and no caller outside the nightly run and the retry
 * path has any use for them.
 */
export function describeStoredCard(row: StoredCardRow | undefined | null): StoredCard | null {
  if (!row) return null;
  return {
    provider: row.provider,
    card_brand: row.card_brand,
    card_last4: row.card_last4,
    since: row.updated_at ?? row.created_at,
  };
}

/**
 * Adds `purpose=<purpose>` to a configured return URL, so the member app's
 * payment return page knows a card replacement from a payment. `PAYMENT_OK_URL`
 * and `PAYMENT_KO_URL` are environment configuration and may already carry a
 * query string or a fragment; an unset one stays empty, which is what the
 * payment page treats as "no redirect configured".
 */
export function withPurposeParam(url: string, purpose: PaymentPagePurpose): string {
  if (!url) return url;
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}purpose=${encodeURIComponent(purpose)}${hash}`;
}
