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
import { isRecurringLineIdShared, SharedRecurringLineError } from './recurring-line-sharing';

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
 * The lines of `fromSetId`, copied onto `toSetId` as inherited lines (a new version's Draft). A copy
 * keeps the line's `line_ref`, so it is recognised as the same purchase across versions, and its
 * schedule. `carryAssignee` keeps who each line is for (`cloneConfiguration()`); the merge of an
 * active version into a Draft never did (`mergeActiveVersionIntoDraft()`). Returns the old → new
 * line ids.
 */
export async function copyRecurringLines(
  tx: Conn, gymId: string, fromSetId: number, toSetId: number, opts: { carryAssignee: boolean },
): Promise<Map<number, number>> {
  const { rows } = await tx.query<any>(
    `SELECT id, product_id, quantity, starts_at, ends_at, item_name, item_type, unit_price, item_billing_frequency,
            currency, schedule_id, list_unit_price, direct_discount_percent, assigned_member_id, line_ref, origin
       FROM member_products_recurrent_snapshot WHERE gym_id = ? AND product_set_id = ? ORDER BY id`,
    [gymId, fromSetId]);
  const copied = new Map<number, number>();
  if (rows.length === 0) return copied;
  const now = await utcNow(tx);
  for (const r of rows) {
    const assignee = opts.carryAssignee ? r.assigned_member_id : null;
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
    copied.set(Number(r.id), lineId);
    // The copy's snapshot, from the very values the copy was written with.
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
    await linkToSet(tx, toSetId, Number(snapshotId));
  }
  return copied;
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
