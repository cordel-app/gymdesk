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
 * `member_products_oneoff_snapshot` stays the purchase and financial record (its
 * `payment_request_id` is how a purchase reaches its payment), so a reader that needs the payment
 * joins it through `member_product_id`; nothing else is read from it.
 */
const PURCHASE_SNAPSHOT_COLUMNS = `
  source_id AS id, gym_id, member_id, product_id, status, product_name, product_type,
  billing_frequency, units, unit_price AS amount, currency, purchased_at, created_at, created_by,
  origin, valid_until, cancelled_on, tax_rate_percent, list_price, direct_discount_percent,
  direct_discount_amount, assigned_member_id, member_product_id`;

/**
 * The member's purchases as a derived table, filtered per arm so each table is read through its
 * own `(gym_id, member_id)` index rather than after the union. Bind `memberPurchaseSnapshotParams()`
 * in its place.
 */
export const MEMBER_PURCHASE_SNAPSHOTS_SQL = `(
  SELECT ${PURCHASE_SNAPSHOT_COLUMNS} FROM product_session_snapshots
   WHERE source_id IS NOT NULL AND gym_id = ? AND member_id = ?
  UNION ALL
  SELECT ${PURCHASE_SNAPSHOT_COLUMNS} FROM product_oneoff_snapshots
   WHERE source_id IS NOT NULL AND gym_id = ? AND member_id = ?
)`;

export function memberPurchaseSnapshotParams(gymId: string, memberId: number): Array<string | number> {
  return [gymId, memberId, gymId, memberId];
}
