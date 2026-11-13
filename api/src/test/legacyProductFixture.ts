/**
 * #2126 stage 5d-6 — test fixture only. The three legacy Product tables
 * (`member_products_oneoff_snapshot`, `member_products_oneoff_promotion_snapshot`,
 * `member_products_recurrent_snapshot`) are dropped (migration 415). A test that seeded a purchase, a
 * purchase Promotion or a recurring line by writing one of those tables by hand keeps its statement and
 * hands it to `legacyProductInsert()`, which writes the Product snapshot row the application's writers
 * (`purchase-writer.ts`, `recurring-line-writer.ts`) would have written, under the same id rules:
 *
 *   - a purchase takes its id from `product_purchase_ids` and is written to `product_session_snapshots`
 *     (a Sessions package) or `product_oneoff_snapshots`, `source_id = member_product_id = id`, and is
 *     linked to the Billing Event of the `payment_request_id` it names;
 *   - a purchase Promotion is a `product_promotion_snapshots` row with `source_purchase_promotion_id = id`,
 *     under the snapshot of the purchase it names (`member_product_id`);
 *   - a recurring line is a `product_periodical_snapshots` row with `source_id = id`, linked to the Product
 *     Set it names (`product_set_id`), its owner and status the set's.
 *
 * The values are the statement's own: each `VALUES` token (a `?`, a literal or an expression such as
 * `DATE_SUB(UTC_DATE(), INTERVAL 10 DAY)`) is evaluated by MySQL with the statement's parameters. The
 * result is `{ insertId }`, the id a reader reports the row under, as `db.query` answered for the table.
 */
import { db, type Tx } from '../infra/db';
import { PURCHASE_EVENT_JUNCTIONS, syncProductSnapshotJunctions } from '../api/snapshot-junction-sync';
import { syncProductSnapshotsOfVersion } from '../api/product-snapshot-sync';

type Conn = Pick<Tx, 'query'>;

const LEGACY_INSERT =
  /^\s*INSERT INTO (member_products_oneoff_snapshot|member_products_oneoff_promotion_snapshot|member_products_recurrent_snapshot)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/i;

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0; let quote: string | null = null; let cur = '';
  for (const ch of text) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The statement's columns and their values, evaluated by MySQL. */
async function evaluate(conn: Conn, columnsText: string, valuesText: string, params: unknown[]): Promise<Record<string, any>> {
  const columns = columnsText.split(',').map((c) => c.trim());
  const tokens = splitTopLevel(valuesText);
  if (columns.length !== tokens.length) throw new Error('legacy product fixture: column/value mismatch');
  const { rows } = await conn.query<any>(
    `SELECT ${tokens.map((t, i) => `${t} AS v${i}`).join(', ')}`, params);
  return Object.fromEntries(columns.map((c, i) => [c, rows[0][`v${i}`]]));
}

const opt = (v: Record<string, any>, key: string) => (key in v ? v[key] : null);

async function insertPurchase(conn: Conn, v: Record<string, any>): Promise<number> {
  const { insertId: allocated } = await conn.query('INSERT INTO product_purchase_ids (gym_id) VALUES (?)', [v.gym_id]);
  const id = Number(allocated);
  const isSessions = v.product_type === 'sessions';
  const table = isSessions ? 'product_session_snapshots' : 'product_oneoff_snapshots';
  const { insertId: snapshotId } = await conn.query(
    `INSERT INTO ${table}
       (gym_id, member_id, product_set_id, product_id, source_id, status, is_inherited, product_name, product_type,
        billing_frequency, units, quantity, currency, unit_price, list_price, direct_discount_percent,
        direct_discount_amount, tax_rate_percent, origin, member_product_id, purchased_at, validity_days,
        valid_until, cancelled_on, created_at, created_by, modified_at, modified_by, assigned_member_id)
     VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, UTC_TIMESTAMP()), ?, ?, ?, ?)`,
    [
      v.gym_id, v.member_id, opt(v, 'product_id'), id, opt(v, 'status') ?? 'pending_payment', v.product_name,
      v.product_type, opt(v, 'billing_frequency'), opt(v, 'units'), opt(v, 'currency') ?? 'EUR', v.amount,
      opt(v, 'list_price'), opt(v, 'direct_discount_percent'), opt(v, 'direct_discount_amount'),
      opt(v, 'tax_rate_percent'), opt(v, 'origin'), id, opt(v, 'purchased_at'), opt(v, 'validity_days'),
      opt(v, 'valid_until'), opt(v, 'cancelled_on'), opt(v, 'created_at'), opt(v, 'created_by'),
      opt(v, 'modified_at'), opt(v, 'modified_by'), opt(v, 'assigned_member_id'),
    ]);
  const requestId = opt(v, 'payment_request_id');
  if (requestId != null) {
    const j = PURCHASE_EVENT_JUNCTIONS.find((x) => x.table === table)!;
    await conn.query(
      `INSERT IGNORE INTO ${j.junction} (billing_event_id, ${j.snapshotCol})
       SELECT pr.billing_event_id, ? FROM payment_requests pr WHERE pr.id = ? AND pr.billing_event_id IS NOT NULL`,
      [snapshotId, requestId]);
  }
  return id;
}

async function insertPurchasePromotion(conn: Conn, v: Record<string, any>): Promise<number> {
  for (const [table, col] of [
    ['product_session_snapshots', 'product_session_snapshot_id'],
    ['product_oneoff_snapshots', 'product_oneoff_snapshot_id'],
  ] as const) {
    const { insertId } = await conn.query(
      `INSERT INTO product_promotion_snapshots
         (gym_id, member_id, ${col}, promotion_id, promotion_name, status, benefit_action, benefit_value,
          duration_cycles, regular_amount, final_amount, applied_at, created_at)
       SELECT s.gym_id, s.member_id, s.id, ?, ?, 'applied', ?, ?, ?, ?, ?,
              COALESCE(?, UTC_TIMESTAMP()), COALESCE(?, UTC_TIMESTAMP())
         FROM ${table} s WHERE s.gym_id = ? AND s.source_id = ?`,
      [
        v.promotion_id, v.promotion_name, v.benefit_action, opt(v, 'benefit_value'), opt(v, 'duration_cycles'),
        v.regular_amount, v.final_amount, opt(v, 'applied_at'), opt(v, 'applied_at'), v.gym_id, v.member_product_id,
      ]);
    if (insertId) {
      await conn.query('UPDATE product_promotion_snapshots SET source_purchase_promotion_id = id WHERE id = ?', [insertId]);
      return Number(insertId);
    }
  }
  throw new Error(`legacy product fixture: purchase ${v.member_product_id} has no snapshot`);
}

async function insertRecurringLine(conn: Conn, v: Record<string, any>): Promise<number> {
  const setId = opt(v, 'product_set_id');
  if (setId == null) throw new Error('legacy product fixture: a recurring line names its product_set_id');
  const { insertId } = await conn.query(
    `INSERT INTO product_periodical_snapshots
       (gym_id, member_id, product_set_id, product_id, source_id, line_ref, status, is_inherited, product_name,
        product_type, billing_frequency, quantity, currency, unit_price, list_price, direct_discount_percent,
        starts_at, ends_at, origin, schedule_id, created_at, assigned_member_id)
     SELECT ps.gym_id, ps.owner_member_id, ps.id, p.id, NULL, ?, ps.status, ?, COALESCE(?, p.name), COALESCE(?, p.type),
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, UTC_TIMESTAMP()), ?
       FROM product_sets ps JOIN products p ON p.id = ?
      WHERE ps.id = ? AND ps.gym_id = ?`,
    [
      opt(v, 'line_ref'), opt(v, 'is_inherited') ?? 0, opt(v, 'item_name'), opt(v, 'item_type'),
      opt(v, 'item_billing_frequency'), opt(v, 'quantity') ?? 1, opt(v, 'currency'), opt(v, 'unit_price'),
      opt(v, 'list_unit_price'), opt(v, 'direct_discount_percent'), v.starts_at, opt(v, 'ends_at'),
      opt(v, 'origin'), opt(v, 'schedule_id'), opt(v, 'created_at'), opt(v, 'assigned_member_id'),
      v.product_id, setId, v.gym_id,
    ]);
  if (!insertId) throw new Error(`legacy product fixture: Product Set ${setId} not found`);
  const id = Number(insertId);
  await conn.query('UPDATE product_periodical_snapshots SET source_id = id, line_ref = COALESCE(line_ref, id) WHERE id = ?', [id]);
  await conn.query(
    'INSERT IGNORE INTO product_set_periodical_snapshots (product_set_id, product_periodical_snapshot_id) VALUES (?, ?)',
    [setId, id]);
  await syncProductSnapshotJunctions(conn, String(v.gym_id), Number(setId));
  await syncProductSnapshotsOfVersion(conn, String(v.gym_id), Number(setId));
  return id;
}

/** Whether a statement is a hand-written legacy Product INSERT this fixture takes. */
export function isLegacyProductInsert(sql: string): boolean {
  return LEGACY_INSERT.test(sql);
}

/** Writes a legacy-shaped Product INSERT as the Product snapshot row it stands for (see the file header). */
export async function legacyProductInsert(
  sql: string, params: unknown[] = [], conn: Conn = db,
): Promise<{ insertId: number; rows: never[] }> {
  const m = sql.match(LEGACY_INSERT);
  if (!m) throw new Error('legacy product fixture: not a single-row INSERT into a legacy Product table');
  const values = await evaluate(conn, m[2], m[3], [...params]);
  const table = m[1].toLowerCase();
  const insertId = table === 'member_products_oneoff_snapshot' ? await insertPurchase(conn, values)
    : table === 'member_products_oneoff_promotion_snapshot' ? await insertPurchasePromotion(conn, values)
      : await insertRecurringLine(conn, values);
  return { insertId, rows: [] };
}
