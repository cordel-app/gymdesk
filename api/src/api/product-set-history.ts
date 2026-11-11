import type { Tx } from '../infra/db';

/**
 * #2125 M5d-2 — a Product Set's history, read through `previous_product_set_id`.
 *
 * `root_product_set_id` is gone (migration 400): Oscar's model (2026-11-03) has
 * no chain identity, only the owner and the historical link from a Product Set
 * to the one it replaced. Where a writer still needs to know whether something
 * belongs to "this line of the owner's history" — a schedule this set or one of
 * its predecessors opened — it walks that link here, and nowhere else.
 *
 * Returns the set itself followed by each predecessor, newest first. A set of
 * another gym, or one that does not exist, has no history (`[]`).
 */
export async function productSetHistoryIds(tx: Tx, gymId: string, productSetId: number): Promise<number[]> {
  const { rows } = await tx.query<{ id: number }>(
    `WITH RECURSIVE history (id, previous_product_set_id, depth) AS (
       SELECT id, previous_product_set_id, 0 FROM product_sets WHERE id = ? AND gym_id = ?
       UNION ALL
       SELECT p.id, p.previous_product_set_id, h.depth + 1
         FROM product_sets p JOIN history h ON p.id = h.previous_product_set_id
        WHERE p.gym_id = ?
     )
     SELECT id FROM history ORDER BY depth`,
    [productSetId, gymId, gymId]);
  return rows.map((r) => Number(r.id));
}
