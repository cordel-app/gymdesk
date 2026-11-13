/**
 * #2126 stage 5d-5 — the Product snapshot tables read under the legacy tables' column names.
 *
 * Since stage 5d-5 a purchase or a recurring line is written to its Product snapshot only, so a test
 * that checks what an API call wrote reads these derived tables instead of the legacy
 * `member_products_oneoff_snapshot`, `member_products_oneoff_promotion_snapshot` and
 * `member_products_recurrent_snapshot`. Interpolate one where the legacy table was named
 * (`FROM ${TEST_PURCHASES} mp WHERE …`). Test-only: production reads go through
 * `purchase-snapshots.ts` and the Product Set junctions.
 */

const purchaseArm = (table: string, junction: string, snapshotCol: string) => `
  SELECT s.source_id AS id, s.gym_id, s.member_id, s.product_id, s.status, s.product_name, s.product_type,
         s.billing_frequency, s.units, s.unit_price AS amount, s.currency, s.tax_rate_percent, s.purchased_at,
         s.valid_until, s.cancelled_on, s.validity_days, s.origin, s.list_price, s.direct_discount_percent,
         s.direct_discount_amount, s.assigned_member_id, s.product_set_id, s.created_at, s.created_by,
         s.modified_at, s.modified_by,
         (SELECT MAX(pr.id) FROM ${junction} j
            JOIN payment_requests pr ON pr.billing_event_id = j.billing_event_id AND pr.gym_id = s.gym_id
           WHERE j.${snapshotCol} = s.id) AS payment_request_id
    FROM ${table} s WHERE s.source_id IS NOT NULL`;

/** Every one-time purchase, in `member_products_oneoff_snapshot`'s shape. */
export const TEST_PURCHASES = `(${purchaseArm('product_session_snapshots', 'billing_event_session_snapshots', 'product_session_snapshot_id')}
  UNION ALL ${purchaseArm('product_oneoff_snapshots', 'billing_event_oneoff_snapshots', 'product_oneoff_snapshot_id')})`;

/** Every Promotion frozen onto a purchase, in `member_products_oneoff_promotion_snapshot`'s shape. */
export const TEST_PURCHASE_PROMOTIONS = `(
  SELECT p.source_purchase_promotion_id AS id, p.gym_id, COALESCE(ss.source_id, os.source_id) AS member_product_id,
         p.promotion_id, p.promotion_name, p.benefit_action, p.benefit_value, p.duration_cycles,
         p.regular_amount, p.final_amount, p.applied_at
    FROM product_promotion_snapshots p
    LEFT JOIN product_session_snapshots ss ON ss.id = p.product_session_snapshot_id
    LEFT JOIN product_oneoff_snapshots os ON os.id = p.product_oneoff_snapshot_id
   WHERE p.source_purchase_promotion_id IS NOT NULL)`;

/** Every recurring Product line, in `member_products_recurrent_snapshot`'s shape (`product_set_id` = the set that wrote it). */
export const TEST_RECURRING_LINES = `(
  SELECT s.source_id AS id, s.gym_id, s.product_set_id, s.product_id, s.quantity, s.starts_at, s.ends_at,
         s.product_name AS item_name, s.product_type AS item_type, s.unit_price,
         s.billing_frequency AS item_billing_frequency, s.currency, s.schedule_id,
         s.list_price AS list_unit_price, s.direct_discount_percent, s.assigned_member_id, s.line_ref, s.origin,
         s.is_inherited, s.created_at
    FROM product_periodical_snapshots s WHERE s.source_id IS NOT NULL)`;
