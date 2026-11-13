/**
 * #2126 stage 5c-2b — the one spelling of "another Product Set links this recurring line snapshot".
 *
 * Stage 5c-2 links an unchanged recurring line across Product Set versions instead of copying it, as
 * #2125 M4b did for plans. Before any line is linked, this stage makes the junction the record of the
 * link and makes a shared line immutable, exactly as M4b-1 did for plan snapshots
 * (`planSnapshotSharedSql()` in `plan-snapshot-lines.ts`):
 *
 * - `syncProductSnapshotJunctions()` only adds the link a line's own `product_set_id` implies and never
 *   removes one (a link is released by deleting the line, whose junction rows cascade);
 * - `syncProductSnapshotsOfVersion()` moves the status and owner of, and re-derives the Promotions on,
 *   the lines only the set links;
 * - `updateRecurringLine()` refuses to write a shared line: a writer that must change one owns a copy of
 *   it first, through `ownRecurringLine()` (stage 5c-2c-1); the linking itself is 5c-2c-2.
 *
 * While `cloneConfiguration()` still copies every line, no line is linked by two sets, so nothing here
 * changes behaviour.
 */
import type { Tx } from '../infra/db';

/**
 * SQL for "a Product Set other than `setExpr` links the recurring line snapshot `snapIdExpr`". `setExpr`
 * may be `NULL` to ask whether more than nobody links it at all.
 */
export const recurringLineSharedSql = (snapIdExpr: string, setExpr: string): string =>
  `EXISTS (SELECT 1 FROM product_set_periodical_snapshots shl_
            WHERE shl_.product_periodical_snapshot_id = ${snapIdExpr} AND NOT (shl_.product_set_id <=> ${setExpr}))`;

/** Whether a Product Set other than `productSetId` links the recurring line snapshot. */
export async function isRecurringLineShared(
  tx: Pick<Tx, 'query'>, productSetId: number, snapshotId: number,
): Promise<boolean> {
  const { rows } = await tx.query<{ shared: number }>(
    `SELECT ${recurringLineSharedSql('?', '?')} AS shared`, [snapshotId, productSetId]);
  return Number(rows[0]?.shared ?? 0) === 1;
}

/** Whether more than one Product Set links the snapshot of the legacy line `lineId` (its `source_id`). */
export async function isRecurringLineIdShared(
  tx: Pick<Tx, 'query'>, gymId: string, lineId: number,
): Promise<boolean> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM product_set_periodical_snapshots j
       JOIN product_periodical_snapshots s ON s.id = j.product_periodical_snapshot_id
      WHERE s.source_id = ? AND s.gym_id = ?`, [lineId, gymId]);
  return Number(rows[0]?.n ?? 0) > 1;
}

/** Thrown by a writer asked to change a line another Product Set still links. */
export class SharedRecurringLineError extends Error {
  constructor(lineId: number) {
    super(`recurring line ${lineId} is linked by more than one Product Set and cannot be written`);
    this.name = 'SharedRecurringLineError';
  }
}

/**
 * #2126 stage 5c-2c-2 — SQL for "the recurring line snapshot `snapIdExpr` is carried over from the Product Set
 * before `setExpr`": the previous Product Set links it too (a new version links its predecessor's unchanged lines),
 * or it is a copy of another line snapshot (`copied_from_periodical_snapshot_id`, #2126 stage 6a: the merge's
 * copies and a shared line a writer owned). The
 * one derivation of a line's inheritance, as `planSnapshotInheritedSql()` is for plans.
 */
export const recurringLineInheritedSql = (snapAlias: string, setExpr: string): string =>
  `(${snapAlias}.copied_from_periodical_snapshot_id IS NOT NULL OR EXISTS (
     SELECT 1 FROM product_sets ihs_
       JOIN product_set_periodical_snapshots ihl_ ON ihl_.product_set_id = ihs_.previous_product_set_id
      WHERE ihs_.id = ${setExpr} AND ihl_.product_periodical_snapshot_id = ${snapAlias}.id))`;
