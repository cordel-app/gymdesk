/**
 * #2126 stage 5c — the one writer of a recurring Product line.
 *
 * A recurring line of a Product Set version is written twice until stage 5d drops the legacy
 * table: the legacy record (`member_products_recurrent_snapshot`) and its Product snapshot
 * (`product_periodical_snapshots`, linked to the set through `product_set_periodical_snapshots`).
 * Every insert, copy, change and removal of a line goes through this module, which writes both
 * rows from the same values in the same call, so nothing re-derives a line's snapshot from the
 * legacy record any more (`syncProductSnapshotsOfVersion()` only keeps the snapshot's status and
 * owner in step with its Product Set, and the Promotions a line owns).
 *
 * The snapshot keeps the legacy record's id in `source_id`, which is the id the routes, the
 * consumption ledger and a line's Promotion applications are still keyed on.
 */
import type { Tx } from '../infra/db';
import { isRecurringLineIdShared, recurringLineSharedSql, SharedRecurringLineError } from './recurring-line-sharing';

type Conn = Pick<Tx, 'query'>;

const ITEM_NAME_EXPR = "COALESCE(gc.name, ct.name, CONCAT('Product #', gc.id))";
const ITEM_TYPE_EXPR = "COALESCE(gc.type, 'other')";

async function utcNow(tx: Conn): Promise<string> {
  const { rows } = await tx.query<{ now: string }>("SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS now");
  return String(rows[0].now);
}

async function linkToSet(tx: Conn, productSetId: number, snapshotId: number): Promise<void> {
  await tx.query(
    'INSERT IGNORE INTO product_set_periodical_snapshots (product_set_id, product_periodical_snapshot_id) VALUES (?, ?)',
    [productSetId, snapshotId]);
}

export interface NewRecurringLine {
  gymId: string;
  productSetId: number;
  productId: number;
  quantity: number;
  startsAt: string;
  scheduleId?: number | null;
  origin?: string | null;
  assignedMemberId?: number | null;
}

/**
 * A new line, frozen from the Product as it stands now. Returns the line's id (the legacy record's,
 * which is the snapshot's `source_id`), or `null` when the Product is not one of the gym's.
 */
export async function insertRecurringLine(tx: Conn, line: NewRecurringLine): Promise<number | null> {
  const now = await utcNow(tx);
  const params = [line.quantity, line.startsAt, line.scheduleId ?? null, line.origin ?? null,
    line.assignedMemberId ?? null, now];
  const { insertId } = await tx.query(
    `INSERT INTO member_products_recurrent_snapshot
       (gym_id, product_set_id, product_id, quantity, starts_at, schedule_id, origin, assigned_member_id, created_at,
        item_name, item_type, unit_price, item_billing_frequency, currency)
     SELECT gc.gym_id, ?, gc.id, ?, ?, ?, ?, ?, ?,
            ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR}, COALESCE(gc.amount, 0), gc.billing_frequency, gc.currency
       FROM products gc LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
      WHERE gc.id = ? AND gc.gym_id = ?`,
    [line.productSetId, ...params, line.productId, line.gymId]);
  if (!insertId) return null;
  const lineId = Number(insertId);
  await tx.query('UPDATE member_products_recurrent_snapshot SET line_ref = id WHERE id = ?', [lineId]);

  const { insertId: snapshotId } = await tx.query(
    `INSERT INTO product_periodical_snapshots
       (gym_id, member_id, product_set_id, product_id, source_id, line_ref, status, is_inherited,
        quantity, starts_at, schedule_id, origin, assigned_member_id, created_at,
        product_name, product_type, unit_price, billing_frequency, currency)
     SELECT gc.gym_id, ps.owner_member_id, ps.id, gc.id, ?, ?, ps.status, 0,
            ?, ?, ?, ?, ?, ?,
            ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR}, COALESCE(gc.amount, 0), gc.billing_frequency, gc.currency
       FROM products gc LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
       JOIN product_sets ps ON ps.id = ? AND ps.gym_id = gc.gym_id
      WHERE gc.id = ? AND gc.gym_id = ?`,
    [lineId, lineId, ...params, line.productSetId, line.productId, line.gymId]);
  await linkToSet(tx, line.productSetId, Number(snapshotId));
  return lineId;
}

/**
 * #2126 stage 5c-2c-2 — the recurring lines of `fromSetId`, **linked** to `toSetId` (a new version's Draft,
 * `cloneConfiguration()`), as #2125 M4b-3 links a version's plan snapshots: an unchanged line is one snapshot
 * (and one legacy line) shared by the two sets, so it keeps its id, its `line_ref`, its schedule and who it is
 * for across versions. It is immutable to both sets (`updateRecurringLine()` refuses it); the first writer that
 * changes it for the new version takes a copy through `ownRecurringLine()`, which is when, and only when, a copy
 * is made. The predecessor's link order is kept.
 */
export async function linkRecurringLines(tx: Conn, gymId: string, fromSetId: number, toSetId: number): Promise<void> {
  await tx.query(
    `INSERT IGNORE INTO product_set_periodical_snapshots (product_set_id, product_periodical_snapshot_id)
     SELECT ?, lnk.product_periodical_snapshot_id
       FROM product_set_periodical_snapshots lnk
       JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
      WHERE s.gym_id = ? AND lnk.product_set_id = ? AND s.source_id IS NOT NULL
      ORDER BY lnk.id`,
    [toSetId, gymId, fromSetId]);
}

/**
 * The lines of `fromSetId`, copied onto `toSetId` as inherited lines: the merge of an active version into an
 * existing Draft (`mergeActiveVersionIntoDraft()`), which does not carry who each line is for. A copy keeps the
 * line's `line_ref`, so it is recognised as the same purchase across versions, and its schedule. The lines are
 * the set's links (#2126 stage 5c-2c-2: a set's lines may have been written by an earlier set), read from their
 * snapshots. Returns the old → new line ids.
 */
export async function copyRecurringLines(
  tx: Conn, gymId: string, fromSetId: number, toSetId: number, opts: { carryAssignee: boolean },
): Promise<Map<number, number>> {
  const { rows } = await tx.query<any>(
    `SELECT ${SNAPSHOT_LINE_COLUMNS}
       FROM product_set_periodical_snapshots lnk
       JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
      WHERE s.gym_id = ? AND lnk.product_set_id = ? AND s.source_id IS NOT NULL
      ORDER BY lnk.id`,
    [gymId, fromSetId]);
  const copied = new Map<number, number>();
  if (rows.length === 0) return copied;
  const now = await utcNow(tx);
  for (const r of rows) {
    const { lineId, snapshotId } = await copyLine(tx, gymId, r, toSetId, opts.carryAssignee ? r.assigned_member_id : null, now);
    copied.set(Number(r.id), lineId);
    await linkToSet(tx, toSetId, snapshotId);
  }
  return copied;
}

/** A line's values read from its snapshot (written from the same values as the legacy record), by their legacy names. */
const SNAPSHOT_LINE_COLUMNS = `s.source_id AS id, s.product_id, s.quantity, s.starts_at, s.ends_at,
            s.product_name AS item_name, s.product_type AS item_type, s.unit_price,
            s.billing_frequency AS item_billing_frequency, s.currency, s.schedule_id,
            s.list_price AS list_unit_price, s.direct_discount_percent, s.assigned_member_id, s.line_ref, s.origin`;

/**
 * One legacy line written onto `toSetId` as an inherited line, with its snapshot from the very values the
 * copy was written with. The snapshot is not linked: the caller links it, or re-points a link at it.
 */
async function copyLine(
  tx: Conn, gymId: string, r: any, toSetId: number, assignee: number | null, now: string,
): Promise<{ lineId: number; snapshotId: number }> {
  const { insertId } = await tx.query(
    `INSERT INTO member_products_recurrent_snapshot
       (gym_id, product_set_id, product_id, quantity, starts_at, ends_at, item_name, item_type, unit_price,
        item_billing_frequency, currency, schedule_id, list_unit_price, direct_discount_percent, assigned_member_id,
        line_ref, origin, is_inherited, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [gymId, toSetId, r.product_id, r.quantity, r.starts_at, r.ends_at, r.item_name, r.item_type, r.unit_price,
      r.item_billing_frequency, r.currency, r.schedule_id, r.list_unit_price, r.direct_discount_percent, assignee,
      r.line_ref, r.origin, now]);
  const lineId = Number(insertId);
  const { insertId: snapshotId } = await tx.query(
    `INSERT INTO product_periodical_snapshots
       (gym_id, member_id, product_set_id, product_id, source_id, status, is_inherited, product_name, product_type,
        billing_frequency, quantity, currency, unit_price, list_price, direct_discount_percent, starts_at, ends_at,
        origin, schedule_id, line_ref, created_at, assigned_member_id)
     SELECT ps.gym_id, ps.owner_member_id, ps.id, p.id, ?, ps.status, 1, COALESCE(?, p.name), COALESCE(?, p.type),
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM product_sets ps JOIN products p ON p.id = ?
      WHERE ps.id = ? AND ps.gym_id = ?`,
    [lineId, r.item_name, r.item_type, r.item_billing_frequency, r.quantity, r.currency, r.unit_price,
      r.list_unit_price, r.direct_discount_percent, r.starts_at, r.ends_at, r.origin, r.schedule_id, r.line_ref,
      now, assignee, r.product_id, toSetId, gymId]);
  if (!snapshotId) throw new Error(`recurring line ${r.id} could not be copied`);
  return { lineId, snapshotId: Number(snapshotId) };
}

/**
 * #2126 stage 5c-2c — a Product Set writes only the recurring lines it owns, as #2125 M4a's
 * `ownPlanSnapshot()` does for plans. When the line `lineId` (a legacy id, the snapshot's `source_id`)
 * that `productSetId` links is linked by another Product Set too, the set takes a copy of it: a new legacy
 * line and snapshot with the same values, `line_ref` and assignee, written onto the set; the set's link is
 * **re-pointed** at the copy (never re-created, so the line keeps its place), and the Product-target
 * Promotions the set applied to the line follow it to the copy. Answers the id the writer must then write
 * by: the copy's when the line was shared, `lineId` itself otherwise (or `null` when the set does not link
 * the line at all).
 *
 * Since stage 5c-2c-2 a new version links its predecessor's lines (`linkRecurringLines()`), so this is where
 * a line an edit changes is first copied.
 */
export async function ownRecurringLine(
  tx: Conn, gymId: string, productSetId: number, lineId: number,
): Promise<number | null> {
  const { rows: linked } = await tx.query<{ snapshot_id: number; shared: number }>(
    `SELECT s.id AS snapshot_id, ${recurringLineSharedSql('s.id', 'lnk.product_set_id')} AS shared
       FROM product_set_periodical_snapshots lnk
       JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
      WHERE lnk.product_set_id = ? AND s.source_id = ? AND s.gym_id = ?`,
    [productSetId, lineId, gymId]);
  if (!linked[0]) return null;
  if (Number(linked[0].shared) !== 1) return lineId;

  // The line's values are its snapshot's (written from the same values as the legacy record), read under
  // the snapshot's own lock, in the legacy column names `copyLine()` takes.
  const { rows } = await tx.query<any>(
    `SELECT ${SNAPSHOT_LINE_COLUMNS}
       FROM product_periodical_snapshots s WHERE s.id = ? AND s.gym_id = ? FOR UPDATE`,
    [Number(linked[0].snapshot_id), gymId]);
  if (!rows[0]) return null;
  const { lineId: copyId, snapshotId } = await copyLine(tx, gymId, rows[0], productSetId, rows[0].assigned_member_id, await utcNow(tx));
  await tx.query(
    `UPDATE product_set_periodical_snapshots SET product_periodical_snapshot_id = ?
      WHERE product_set_id = ? AND product_periodical_snapshot_id = ?`,
    [snapshotId, productSetId, Number(linked[0].snapshot_id)]);
  await tx.query(
    `UPDATE user_membership_promotions SET recurrent_snapshot_id = ?
      WHERE gym_id = ? AND product_set_id = ? AND recurrent_snapshot_id = ?`,
    [copyId, gymId, productSetId, lineId]);
  return copyId;
}

/** The columns of a line that change after it is written, by their legacy name. */
export interface RecurringLinePatch {
  quantity?: number;
  ends_at?: string | null;
  schedule_id?: number | null;
  unit_price?: string;
  list_unit_price?: string | null;
  direct_discount_percent?: string | null;
}

const SNAPSHOT_COLUMN: Record<keyof RecurringLinePatch, string> = {
  quantity: 'quantity',
  ends_at: 'ends_at',
  schedule_id: 'schedule_id',
  unit_price: 'unit_price',
  list_unit_price: 'list_price',
  direct_discount_percent: 'direct_discount_percent',
};

/** Changes one line, in the legacy record and in its snapshot. Refuses a line another Product Set links. */
export async function updateRecurringLine(
  tx: Conn, gymId: string, lineId: number, patch: RecurringLinePatch,
): Promise<void> {
  const keys = (Object.keys(patch) as Array<keyof RecurringLinePatch>).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return;
  // #2126 stage 5c-2b: a line another Product Set links is immutable to every set that links it.
  if (await isRecurringLineIdShared(tx, gymId, lineId)) throw new SharedRecurringLineError(lineId);
  const values = keys.map((k) => patch[k] ?? null);
  await tx.query(
    `UPDATE member_products_recurrent_snapshot SET ${keys.map((k) => `${k} = ?`).join(', ')}
      WHERE id = ? AND gym_id = ?`,
    [...values, lineId, gymId]);
  await tx.query(
    `UPDATE product_periodical_snapshots SET ${keys.map((k) => `${SNAPSHOT_COLUMN[k]} = ?`).join(', ')},
            modified_at = UTC_TIMESTAMP()
      WHERE source_id = ? AND gym_id = ?`,
    [...values, lineId, gymId]);
}

/** Removes one line outright (a Draft's line that has charged nothing). Its snapshot's Promotions and link cascade. */
export async function deleteRecurringLine(tx: Conn, gymId: string, lineId: number): Promise<void> {
  await tx.query('DELETE FROM product_periodical_snapshots WHERE source_id = ? AND gym_id = ?', [lineId, gymId]);
  await tx.query('DELETE FROM member_products_recurrent_snapshot WHERE id = ? AND gym_id = ?', [lineId, gymId]);
}
