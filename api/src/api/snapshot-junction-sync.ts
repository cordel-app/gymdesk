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
 * cascade. Nothing here derives a plan link. The Product junctions still follow the column until #2126
 * stage 3 moves the recurring lines.
 *
 *   plan snapshots          -> product_set_plan_snapshots
 *   recurring Product lines -> product_set_periodical_snapshots
 *   session / one-off buys  -> product_set_{session,oneoff}_snapshots (only when a snapshot names a set)
 *   a bought one-time Product -> billing_event_{oneoff,session}_snapshots (through its payment request's event)
 */
import type { Tx } from '../infra/db';

type Conn = Pick<Tx, 'query'>;

/** The Product junctions, still derived from their snapshots' own `product_set_id` (the plan one is not, M5b). */
export const SET_JUNCTIONS = [
  { junction: 'product_set_periodical_snapshots', snapshotCol: 'product_periodical_snapshot_id', table: 'product_periodical_snapshots' },
  { junction: 'product_set_session_snapshots', snapshotCol: 'product_session_snapshot_id', table: 'product_session_snapshots' },
  { junction: 'product_set_oneoff_snapshots', snapshotCol: 'product_oneoff_snapshot_id', table: 'product_oneoff_snapshots' },
] as const;

type SetJunction = (typeof SET_JUNCTIONS)[number];

async function syncOne(tx: Conn, gymId: string, productSetId: number, j: SetJunction): Promise<void> {
  // #2126 stage 5c-2b: the recurring line junction is the record of the link, as the plan one is (M4b-1).
  // It only gains the link a line's own column implies and never loses one here: a line that leaves a set
  // is deleted, and its links cascade. Stage 5c-2c links a line to a set that did not create it.
  if (j.junction !== 'product_set_periodical_snapshots') await tx.query(
    `DELETE j FROM ${j.junction} j
       LEFT JOIN ${j.table} s ON s.id = j.${j.snapshotCol} AND s.gym_id = ? AND s.product_set_id = j.product_set_id
      WHERE j.product_set_id = ? AND s.id IS NULL`,
    [gymId, productSetId]);
  await tx.query(
    `INSERT IGNORE INTO ${j.junction} (product_set_id, ${j.snapshotCol})
     SELECT s.product_set_id, s.id FROM ${j.table} s WHERE s.gym_id = ? AND s.product_set_id = ?`,
    [gymId, productSetId]);
}

/** The recurring Product snapshots of a Product Set (and any session / one-off snapshot that names it). */
export async function syncProductSnapshotJunctions(tx: Conn, gymId: string, productSetId: number): Promise<void> {
  for (const j of SET_JUNCTIONS) await syncOne(tx, gymId, productSetId, j);
}

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
