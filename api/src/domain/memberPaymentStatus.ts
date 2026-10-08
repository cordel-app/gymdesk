/**
 * A Member's aggregated Payment Status (#1235): "is there any payment problem
 * with anything this Member is being charged for?". It is the worst status
 * found across every billable concept, each concept contributing its latest
 * payment request — the membership plan (one concept per Assigned Plan) and
 * each Product bought on its own. Pure: the SQL fragment is built here so the
 * list read and any later reader share one severity order.
 */

/** Worst first. Every `payment_requests.status` value must appear. */
export const PAYMENT_STATUS_SEVERITY = ['failed', 'expired', 'pending', 'completed'] as const;

export type PaymentRequestStatus = (typeof PAYMENT_STATUS_SEVERITY)[number];

/** Sources that carry no fee: a card verification moves no money (#788). */
export const NON_BILLABLE_SOURCES = ['card_update'] as const;

/** The worst of the given statuses; `null` when there are none. */
export function worstPaymentStatus(statuses: ReadonlyArray<string | null | undefined>): string | null {
  let worst: string | null = null;
  let worstRank = Infinity;
  for (const s of statuses) {
    if (!s) continue;
    const idx = (PAYMENT_STATUS_SEVERITY as readonly string[]).indexOf(s);
    // An unknown status ranks below every known one, but is still reported
    // when it is all there is.
    const rank = idx === -1 ? PAYMENT_STATUS_SEVERITY.length : idx;
    if (rank < worstRank) {
      worst = s;
      worstRank = rank;
    }
  }
  return worst;
}

function severityOrderSql(column: string): string {
  const whens = PAYMENT_STATUS_SEVERITY.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ');
  return `CASE ${column} ${whens} ELSE ${PAYMENT_STATUS_SEVERITY.length} END`;
}

/**
 * The billable concept a payment request belongs to: its Assigned Plan, else
 * the Product it bought, else its source.
 */
function conceptSql(alias: string): string {
  return `COALESCE(CONCAT('um:', ${alias}.user_membership_id),
            CONCAT('mp:', (SELECT mp.product_id FROM member_products mp
                           WHERE mp.payment_request_id = ${alias}.id)),
            CONCAT('src:', ${alias}.source))`;
}

function scopeSql(alias: string, memberAlias: string): string {
  const sources = NON_BILLABLE_SOURCES.map((s) => `'${s}'`).join(', ');
  // #640: a covered member follows the Memberships they are covered by.
  return `${alias}.gym_id = ${memberAlias}.gym_id
          AND ${alias}.source NOT IN (${sources})
          AND (${alias}.member_id = ${memberAlias}.id
               OR ${alias}.user_membership_id IN (
                    SELECT umm.user_membership_id FROM user_membership_members umm
                    WHERE umm.member_id = ${memberAlias}.id AND umm.gym_id = ${memberAlias}.gym_id))`;
}

/** Correlated subquery: the aggregated Payment Status of `members` row `memberAlias`. */
export function memberPaymentStatusSql(memberAlias: string): string {
  return `(SELECT pr.status
           FROM payment_requests pr
           WHERE ${scopeSql('pr', memberAlias)}
             AND NOT EXISTS (
               SELECT 1 FROM payment_requests pr2
               WHERE ${scopeSql('pr2', memberAlias)}
                 AND ${conceptSql('pr2')} = ${conceptSql('pr')}
                 AND (pr2.created_at > pr.created_at
                      OR (pr2.created_at = pr.created_at AND pr2.id > pr.id)))
           ORDER BY ${severityOrderSql('pr.status')}, pr.created_at DESC, pr.id DESC
           LIMIT 1)`;
}
