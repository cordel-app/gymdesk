/**
 * A Member's Payment Status (#2574, replacing #1235's payment-request read):
 * derived on read from the Member's **Billing Events**, which are the source
 * of truth, and reported in the Normalized Payment Status vocabulary (#2533).
 *
 *  - no Billing Events            → `null` (the screens read it as "None")
 *  - every event settled          → `completed` (the screens read it as "Paid")
 *  - some event not settled       → the Normalized Payment Status of the **most
 *    recent** unsettled event; an older unsettled event never overrides it.
 *
 * Nothing is stored, so a created, settled or failed event is reflected by the
 * next read with no recalculation step. One SQL fragment serves the Members
 * list (and its filter), the Member Profile header and Home.
 *
 * Which events count: the ledger's own obligations. A card verification moves
 * no money, a status change is not an event, a waiver forgives the amount, an
 * adjustment records no payment and a persisted obligation not yet attempted
 * (`is_scheduled`) has no payment status yet — none of those is either paid or
 * unsettled. The event's own status is `deriveBillingEventStatus()`'s rule,
 * spelled in SQL here for the same reason the list spells it.
 */

import { eventAssignmentSql } from './billingEventOwnership';
import { ASSIGNMENT_BENEFICIARIES } from './assignmentBeneficiaries';

/** Sources that carry no fee: a card verification moves no money (#788). Kept for callers. */
export const NON_BILLABLE_SOURCES = ['card_update'] as const;

/** Event types that are neither paid nor unsettled (see above). */
export const PAYMENT_STATUS_EXCLUDED_EVENT_TYPES = ['status_changed', 'card_verification', 'waived_billing'] as const;

const LATEST_ATTEMPT = (column: string) => `(SELECT pr.${column} FROM payment_requests pr
                WHERE pr.billing_event_id = be.id
                ORDER BY pr.created_at DESC, pr.id DESC LIMIT 1)`;

/** `deriveBillingEventStatus()` in SQL: paid | failed | pending | recorded. */
const EVENT_STATUS_SQL = `CASE ${LATEST_ATTEMPT('status')}
      WHEN 'completed' THEN 'paid'
      WHEN 'failed' THEN 'failed'
      WHEN 'expired' THEN 'failed'
      WHEN 'pending' THEN 'pending'
      ELSE CASE be.event_type
        WHEN 'recurring_payment' THEN 'paid'
        WHEN 'payment_recorded' THEN 'paid'
        WHEN 'failed_billing' THEN 'failed'
        ELSE 'recorded' END
    END`;

/** `normalizePaymentStatus()` in SQL over the latest attempt's raw provider status. */
const NORMALIZED_SQL = `CASE UPPER(TRIM(${LATEST_ATTEMPT('provider_status')}))
      WHEN 'SUCCEEDED' THEN 'completed' WHEN 'PAID_OUT' THEN 'completed'
      WHEN 'PENDING' THEN 'pending' WHEN 'PENDING_PROCESSING' THEN 'pending'
      WHEN 'AUTHORIZED' THEN 'pending' WHEN 'PROCESSING' THEN 'pending'
      WHEN 'FAILED' THEN 'failed' WHEN 'EXPIRED' THEN 'expired'
      WHEN 'CANCELED' THEN 'canceled' WHEN 'REFUNDED' THEN 'refunded'
      WHEN 'PARTIALLY_REFUNDED' THEN 'partially_refunded'
      ELSE NULL END`;

/**
 * Correlated subquery: the Payment Status of `members` row `memberAlias`.
 * The ORDER BY puts every unsettled event before every settled one, newest
 * first, so the first row is the latest unsettled event, else a settled one.
 */
export function memberPaymentStatusSql(memberAlias: string): string {
  const excluded = PAYMENT_STATUS_EXCLUDED_EVENT_TYPES.map((t) => `'${t}'`).join(', ');
  return `(SELECT CASE WHEN ${EVENT_STATUS_SQL} = 'paid' THEN 'completed'
                       ELSE COALESCE(${NORMALIZED_SQL}, ${LATEST_ATTEMPT('status')}, 'failed') END
           FROM billing_events be
           WHERE be.gym_id = ${memberAlias}.gym_id
             AND (be.member_id = ${memberAlias}.id
                  -- #640: a covered Member follows the Membership they are covered by.
                  OR ${eventAssignmentSql('be')} IN (
                       SELECT umm.user_membership_id FROM ${ASSIGNMENT_BENEFICIARIES} umm
                       WHERE umm.member_id = ${memberAlias}.id AND umm.gym_id = ${memberAlias}.gym_id))
             AND be.is_scheduled = 0
             AND be.cancelled_at IS NULL
             AND be.event_type NOT IN (${excluded})
             AND ${EVENT_STATUS_SQL} <> 'recorded'
           ORDER BY (${EVENT_STATUS_SQL} = 'paid'), be.created_at DESC, be.id DESC
           LIMIT 1)`;
}
