/**
 * #2126 stage 3d — the one SQL spelling of "a member's one-time purchases", read from the Product
 * snapshot tables (migration 348) instead of `member_products_oneoff_snapshot`.
 *
 * A bought one-time Product is frozen in exactly one of `product_session_snapshots` (a Sessions
 * package) or `product_oneoff_snapshots` (anything else), kept equal to the purchase by stage 2's
 * dual-write (`syncProductSnapshotForPurchase()`) in the transaction that changed it. The derived
 * table below unions the two into the purchase's own shape: `id` is the purchase id (`source_id`,
 * which every Promotion snapshot and route is still keyed on) and `amount` is what was charged
 * (`unit_price`, written from the purchase's `amount`).
 *
 * #2126 stage 5a: each row also reports `payment_request_id`, the purchase's payment, reached through
 * `Payment Request -> Billing Event <-> snapshot` (`billing_event_{oneoff,session}_snapshots`, the
 * owner's option A) and never through the legacy `member_products_oneoff_snapshot` record: the
 * **latest** request of the linked Billing Event, by id (the owner's default; a purchase has one request
 * and *Pay* reuses it). A purchase whose snapshot is linked to no event (a draft) reports NULL.
 */
const PURCHASE_SNAPSHOT_COLUMNS = `
  source_id AS id, gym_id, member_id, product_id, status, product_name, product_type,
  billing_frequency, units, unit_price AS amount, currency, purchased_at, created_at, created_by,
  origin, validity_days, valid_until, cancelled_on, tax_rate_percent, list_price, direct_discount_percent,
  direct_discount_amount, assigned_member_id, member_product_id`;

/** The purchase's payment request, from the arm's own Billing Event junction (see the header). */
function paymentRequestColumn(table: string, junction: string, snapshotCol: string): string {
  return `(SELECT MAX(pr.id) FROM ${junction} j
            JOIN payment_requests pr ON pr.billing_event_id = j.billing_event_id AND pr.gym_id = ${table}.gym_id
           WHERE j.${snapshotCol} = ${table}.id) AS payment_request_id`;
}

const SESSION_ARM_COLUMNS = `${PURCHASE_SNAPSHOT_COLUMNS},
  ${paymentRequestColumn('product_session_snapshots', 'billing_event_session_snapshots', 'product_session_snapshot_id')}`;
const ONEOFF_ARM_COLUMNS = `${PURCHASE_SNAPSHOT_COLUMNS},
  ${paymentRequestColumn('product_oneoff_snapshots', 'billing_event_oneoff_snapshots', 'product_oneoff_snapshot_id')}`;

/**
 * The member's purchases as a derived table, filtered per arm so each table is read through its
 * own `(gym_id, member_id)` index rather than after the union. Bind `memberPurchaseSnapshotParams()`
 * in its place.
 */
export const MEMBER_PURCHASE_SNAPSHOTS_SQL = `(
  SELECT ${SESSION_ARM_COLUMNS} FROM product_session_snapshots
   WHERE source_id IS NOT NULL AND gym_id = ? AND member_id = ?
  UNION ALL
  SELECT ${ONEOFF_ARM_COLUMNS} FROM product_oneoff_snapshots
   WHERE source_id IS NOT NULL AND gym_id = ? AND member_id = ?
)`;

export function memberPurchaseSnapshotParams(gymId: string, memberId: number): Array<string | number> {
  return [gymId, memberId, gymId, memberId];
}

/**
 * #2126 stage 3p — the purchases matching `predicate` (a condition on the snapshot's own columns,
 * e.g. `gym_id = ? AND status = ?`), in the same shape as `MEMBER_PURCHASE_SNAPSHOTS_SQL`, for a
 * reader that is not about one member (the payment webhook completing a purchase, the cleanup
 * cancelling abandoned ones). The predicate is applied in each arm, so its placeholders are bound
 * twice: pass `purchaseSnapshotParams(params)`.
 */
export function purchaseSnapshotsSql(predicate: string, opts: { notInProductSet?: boolean } = {}): string {
  // #2746 / #2126 stage 6b: a purchase in a member's cart is linked to its Product Set through the
  // arm's `product_set_{session,oneoff}_snapshots` junction, the only record of that link.
  const notLinked = (table: string, junction: string, col: string) => opts.notInProductSet
    ? ` AND NOT EXISTS (SELECT 1 FROM ${junction} psj_ WHERE psj_.${col} = ${table}.id)` : '';
  return `(
  SELECT ${SESSION_ARM_COLUMNS} FROM product_session_snapshots
   WHERE source_id IS NOT NULL AND ${predicate}${notLinked('product_session_snapshots', 'product_set_session_snapshots', 'product_session_snapshot_id')}
  UNION ALL
  SELECT ${ONEOFF_ARM_COLUMNS} FROM product_oneoff_snapshots
   WHERE source_id IS NOT NULL AND ${predicate}${notLinked('product_oneoff_snapshots', 'product_set_oneoff_snapshots', 'product_oneoff_snapshot_id')}
)`;
}

export function purchaseSnapshotParams(params: Array<string | number>): Array<string | number> {
  return [...params, ...params];
}
