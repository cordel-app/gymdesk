/**
 * #2125 / #2126 M2 — the many-to-many junctions between a Product Set and the immutable snapshots it is
 * assembled from (migration 366), written beside the columns the snapshot tables still carry.
 *
 * Until M3 moves the readers and M4 makes a new Product Set link unchanged snapshots instead of
 * copying them, a snapshot belongs to exactly one set through its own `product_set_id`, so the junction
 * is that column spelled as a pair. This module is the **one writer** of the junctions: it re-derives a
 * set's rows from the columns (idempotent `INSERT IGNORE`, stale rows removed). The snapshot side of every
 * junction is `ON DELETE CASCADE` (migration 375), so a deleted snapshot takes its links with it.
 *
 *   plan snapshots          -> product_set_plan_snapshots
 *   recurring Product lines -> product_set_periodical_snapshots
 *   session / one-off buys  -> product_set_{session,oneoff}_snapshots (only when a snapshot names a set)
 *   a bought one-time Product -> billing_event_oneoff_snapshots (through its payment request's event)
 */
import type { Tx } from '../infra/db';

type Conn = Pick<Tx, 'query'>;

export const SET_JUNCTIONS = [
  { junction: 'product_set_plan_snapshots', snapshotCol: 'plan_snapshot_id', table: 'plan_snapshots' },
  { junction: 'product_set_periodical_snapshots', snapshotCol: 'product_periodical_snapshot_id', table: 'product_periodical_snapshots' },
  { junction: 'product_set_session_snapshots', snapshotCol: 'product_session_snapshot_id', table: 'product_session_snapshots' },
  { junction: 'product_set_oneoff_snapshots', snapshotCol: 'product_oneoff_snapshot_id', table: 'product_oneoff_snapshots' },
] as const;

type SetJunction = (typeof SET_JUNCTIONS)[number];

async function syncOne(tx: Conn, gymId: string, productSetId: number, j: SetJunction): Promise<void> {
  await tx.query(
    `DELETE j FROM ${j.junction} j
       LEFT JOIN ${j.table} s ON s.id = j.${j.snapshotCol} AND s.gym_id = ? AND s.product_set_id = j.product_set_id
      WHERE j.product_set_id = ? AND s.id IS NULL`,
    [gymId, productSetId]);
  await tx.query(
    `INSERT IGNORE INTO ${j.junction} (product_set_id, ${j.snapshotCol})
     SELECT s.product_set_id, s.id FROM ${j.table} s WHERE s.gym_id = ? AND s.product_set_id = ?`,
    [gymId, productSetId]);
}

/** The Membership Plan snapshots of a Product Set. */
export async function syncPlanSnapshotJunction(tx: Conn, gymId: string, productSetId: number): Promise<void> {
  await syncOne(tx, gymId, productSetId, SET_JUNCTIONS[0]);
}

/** The recurring Product snapshots of a Product Set (and any session / one-off snapshot that names it). */
export async function syncProductSnapshotJunctions(tx: Conn, gymId: string, productSetId: number): Promise<void> {
  for (const j of SET_JUNCTIONS.slice(1)) await syncOne(tx, gymId, productSetId, j);
}

/** Links a bought one-time Product's snapshot to the Billing Event of its payment request. */
export async function linkPurchaseToBillingEvent(tx: Conn, gymId: string, purchaseId: number): Promise<void> {
  await tx.query(
    `INSERT IGNORE INTO billing_event_oneoff_snapshots (billing_event_id, product_oneoff_snapshot_id)
     SELECT pr.billing_event_id, s.id
       FROM member_products_oneoff_snapshot mp
       JOIN payment_requests pr ON pr.id = mp.payment_request_id AND pr.gym_id = mp.gym_id
       JOIN product_oneoff_snapshots s ON s.source_id = mp.id AND s.gym_id = mp.gym_id
      WHERE mp.id = ? AND mp.gym_id = ? AND pr.billing_event_id IS NOT NULL`,
    [purchaseId, gymId]);
}
