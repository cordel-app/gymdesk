/**
 * #2125 / #2126 M2 — the many-to-many junctions between a Product Set and the immutable snapshots it is
 * assembled from (migration 366), written beside the columns the snapshot tables still carry.
 *
 * Until M3 moved the readers, a snapshot belonged to exactly one set through its own `product_set_id`,
 * so every junction was that column spelled as a pair: this module re-derives a set's rows from the
 * columns (idempotent `INSERT IGNORE`, stale rows removed). The snapshot side of every junction is
 * `ON DELETE CASCADE` (migration 375), so a deleted snapshot takes its links with it.
 *
 * Since M5b (migration 388) the **plan** junction is the only record of the link: `plan_snapshots` has no
 * `product_set_id`, every writer that creates a plan snapshot links it in the same statement sequence, and a
 * link is released by its writer (`ownPlanSnapshot()`, `deleteProductSetAndOwnPlanSnapshots()`) or by the
 * cascade. Nothing here derives a plan link.
 *
 * Since #2126 stage 6b (migration 417) the **Product** junctions are the only record of their link too: the
 * three Product snapshot tables have no `product_set_id`, and each writer links what it writes
 * (`recurring-line-writer.ts`, `linkPurchaseToSet()` in `set-purchases.ts`). A set's own Product snapshots
 * are deleted with it by `deleteProductSetAndOwnPlanSnapshots()`; nothing here derives a Product link.
 *
 *   plan snapshots          -> product_set_plan_snapshots
 *   recurring Product lines -> product_set_periodical_snapshots
 *   session / one-off buys  -> product_set_{session,oneoff}_snapshots (only when a snapshot names a set)
 *   a bought one-time Product -> billing_event_{oneoff,session}_snapshots (through its payment request's event)
 */
/**
 * The junction linking a bought one-time Product's snapshot to its Billing Event, per snapshot table: a
 * Sessions package is frozen in `product_session_snapshots` (#2126 stage 5a, migration 408), anything else
 * in `product_oneoff_snapshots` (migration 366). A purchase reaches its payment through these alone.
 * Written by `insertPurchase()` (`purchase-writer.ts`, #2126 stage 5b) with the event it already holds.
 */
export const PURCHASE_EVENT_JUNCTIONS = [
  { junction: 'billing_event_oneoff_snapshots', snapshotCol: 'product_oneoff_snapshot_id', table: 'product_oneoff_snapshots' },
  { junction: 'billing_event_session_snapshots', snapshotCol: 'product_session_snapshot_id', table: 'product_session_snapshots' },
] as const;
