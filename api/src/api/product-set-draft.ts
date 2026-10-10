import { db, Tx } from '../infra/db';
import { classifyProduct, ProductBenefitCategory } from '../domain/productClassification';
import { isPersonalFeeBenefitAction, PERSONAL_FEE_BENEFIT_ACTIONS } from '../domain/personalFeeBenefit';
import { touchDraft } from './product-sets';

/**
 * #1325 PR 4 — editing a Draft ProductSet's configuration.
 *
 * Every function runs inside the caller's transaction on a Draft it has just
 * locked (`lockDraft()`): a version past `draft`, or a Draft idle for more than
 * two hours, is refused here and nowhere else, so no edit can reach a committed
 * or stale configuration. A successful edit refreshes the Draft's expiry. The
 * rows written are the version's own (`product_set_id`, no assignment); nothing
 * here prices anything — the Billing Event Forecast is the engine's, read back
 * through `loadProductSetSimulationAssignment()`.
 */

export const BENEFIT_TABLE: Record<ProductBenefitCategory, string> = {
  session: 'user_membership_session',
  oneoff: 'user_membership_oneoff',
  periodical: 'user_membership_periodical',
};

export type DraftRefusal =
  | { kind: 'not_found' }
  | { kind: 'not_a_draft'; status: string }
  | { kind: 'expired' }
  | { kind: 'invalid'; message: string };

export interface LockedDraft {
  id: number;
  gym_id: string;
  owner_member_id: number;
  root_product_set_id: number;
  membership_plan_id: number | null;
  version: number;
  starts_at: string;
}

const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/** Locks the Draft; the caller's edit then cannot race a commit or a cancel. */
export async function lockDraft(tx: Tx, gymId: string, id: number): Promise<LockedDraft | DraftRefusal> {
  const { rows } = await tx.query<any>(
    `SELECT id, gym_id, owner_member_id, root_product_set_id, membership_plan_id, version, starts_at, status,
            (status = 'draft' AND last_activity_at < UTC_TIMESTAMP() - INTERVAL 120 MINUTE) AS expired
       FROM product_sets WHERE id = ? AND gym_id = ? FOR UPDATE`,
    [id, gymId],
  );
  const r = rows[0];
  if (!r) return { kind: 'not_found' };
  if (r.status !== 'draft') return { kind: 'not_a_draft', status: String(r.status) };
  if (Number(r.expired) === 1) return { kind: 'expired' };
  return {
    id: Number(r.id), gym_id: String(r.gym_id), owner_member_id: Number(r.owner_member_id),
    root_product_set_id: Number(r.root_product_set_id), membership_plan_id: r.membership_plan_id != null ? Number(r.membership_plan_id) : null,
    version: Number(r.version), starts_at: dateOnly(r.starts_at),
  };
}

export const isRefusal = (v: LockedDraft | DraftRefusal): v is DraftRefusal => 'kind' in v;

async function touch(tx: Tx, draft: LockedDraft) {
  await touchDraft(tx, draft.gym_id, draft.id);
}

const ITEM_NAME_EXPR = "COALESCE(gc.name, ct.name, CONCAT('Product #', gc.id))";
const ITEM_TYPE_EXPR = "COALESCE(gc.type, 'other')";

/* ── Benefit sections ────────────────────────────────────────────────────── */

export async function loadBenefitSection(gymId: string, productSetId: number, category: ProductBenefitCategory) {
  const { rows } = await db.query<any>(
    `SELECT product_id, quantity, item_name, item_type, item_billing_frequency, unit_price, currency,
            \`action\`, \`value\`, mandatory${category === 'session' ? ', frequency' : ''}
       FROM ${BENEFIT_TABLE[category]} WHERE gym_id = ? AND product_set_id = ? ORDER BY id`,
    [gymId, productSetId]);
  return rows;
}

/**
 * Replace-all of one section, `{ product_id, quantity }` per line exactly like the
 * assignment-keyed editor's contract: a line already in the section keeps every
 * frozen fact and only its quantity moves; a newly added Product is held to the
 * catalogue's current state and to the section's own category, and is frozen at
 * its present name, type, price and frequency; a removed one is deleted.
 */
export async function writeBenefitSection(tx: Tx, draft: LockedDraft, category: ProductBenefitCategory,
  items: unknown): Promise<{ ok: true } | DraftRefusal> {
  if (!Array.isArray(items)) return { kind: 'invalid', message: 'items must be an array' };
  const parsed: { product_id: number; quantity: number }[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    const productId = Number((item as any)?.product_id);
    const quantity = Number((item as any)?.quantity);
    if (!Number.isInteger(productId) || productId <= 0) return { kind: 'invalid', message: 'product_id is required' };
    if (!Number.isInteger(quantity) || quantity <= 0) return { kind: 'invalid', message: 'quantity must be a positive integer' };
    if (seen.has(productId)) return { kind: 'invalid', message: `Duplicate product_id: ${productId}` };
    seen.add(productId);
    parsed.push({ product_id: productId, quantity });
  }

  const table = BENEFIT_TABLE[category];
  const { rows: current } = await tx.query<{ product_id: number }>(
    `SELECT product_id FROM ${table} WHERE gym_id = ? AND product_set_id = ?`, [draft.gym_id, draft.id]);
  const attached = new Set(current.map((r) => Number(r.product_id)));
  const added = parsed.filter((p) => !attached.has(p.product_id)).map((p) => p.product_id);
  if (added.length > 0) {
    const { rows: products } = await tx.query<any>(
      `SELECT id, type, billing_frequency, status FROM products
        WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${added.map(() => '?').join(',')})`,
      [draft.gym_id, ...added]);
    if (products.length !== added.length) return { kind: 'invalid', message: 'One or more Products not found in this gym' };
    const inactive = products.find((p: any) => p.status !== 'active');
    if (inactive) return { kind: 'invalid', message: `Product ${inactive.id} is not active in this gym` };
    const mismatched = products.find((p: any) => classifyProduct(p) !== category);
    if (mismatched) return { kind: 'invalid', message: `Product ${mismatched.id} does not belong in the '${category}' category` };
  }

  if (parsed.length === 0) {
    await tx.query(`DELETE FROM ${table} WHERE gym_id = ? AND product_set_id = ?`, [draft.gym_id, draft.id]);
  } else {
    await tx.query(
      `DELETE FROM ${table} WHERE gym_id = ? AND product_set_id = ? AND product_id NOT IN (${parsed.map(() => '?').join(',')})`,
      [draft.gym_id, draft.id, ...parsed.map((p) => p.product_id)]);
  }
  for (const p of parsed) {
    if (attached.has(p.product_id)) {
      await tx.query(`UPDATE ${table} SET quantity = ? WHERE gym_id = ? AND product_set_id = ? AND product_id = ?`,
        [p.quantity, draft.gym_id, draft.id, p.product_id]);
    } else {
      await tx.query(
        `INSERT INTO ${table}
           (gym_id, product_set_id, product_id, quantity, item_name, item_type, item_billing_frequency, unit_price, currency)
         SELECT ?, ?, gc.id, ?, ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR}, gc.billing_frequency, COALESCE(gc.amount, 0), gc.currency
           FROM products gc LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
          WHERE gc.id = ? AND gc.gym_id = ?`,
        [draft.gym_id, draft.id, p.quantity, p.product_id, draft.gym_id]);
    }
  }
  await touch(tx, draft);
  return { ok: true };
}

/* ── Plan snapshot fields ────────────────────────────────────────────────── */

const nonNegInt = (v: unknown): number | false => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : false;
};

export async function setBillingDuration(tx: Tx, draft: LockedDraft, body: any): Promise<{ ok: true } | DraftRefusal> {
  if (draft.membership_plan_id == null) return { kind: 'invalid', message: 'A ProductSet without a Membership Plan has no Billing & Duration' };
  const patch: Record<string, number> = {};
  for (const field of ['free_periods', 'paid_periods', 'bonus_periods', 'pay_beforehand_periods'] as const) {
    if (!(field in (body ?? {}))) continue;
    const v = nonNegInt(body[field]);
    if (v === false) return { kind: 'invalid', message: `${field} must be a non-negative integer` };
    patch[field] = v;
  }
  if ('auto_renew' in (body ?? {})) {
    if (typeof body.auto_renew !== 'boolean' && body.auto_renew !== 0 && body.auto_renew !== 1) {
      return { kind: 'invalid', message: 'auto_renew must be a boolean' };
    }
    patch.auto_renew = body.auto_renew ? 1 : 0;
  }
  if (Object.keys(patch).length === 0) return { kind: 'invalid', message: 'No Billing & Duration fields to update' };

  const { rows } = await tx.query<any>(
    'SELECT paid_periods, pay_beforehand_periods FROM product_set_plan_snapshots WHERE product_set_id = ? AND gym_id = ? FOR UPDATE',
    [draft.id, draft.gym_id]);
  if (!rows[0]) return { kind: 'invalid', message: 'This ProductSet has no plan snapshot' };
  const paid = 'paid_periods' in patch ? patch.paid_periods : Number(rows[0].paid_periods ?? 0);
  const prepaid = 'pay_beforehand_periods' in patch ? patch.pay_beforehand_periods : Number(rows[0].pay_beforehand_periods ?? 0);
  if (prepaid > paid) return { kind: 'invalid', message: 'pay_beforehand_periods cannot exceed paid_periods' };

  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
  await tx.query(`UPDATE product_set_plan_snapshots SET ${sets} WHERE product_set_id = ? AND gym_id = ?`,
    [...Object.values(patch), draft.id, draft.gym_id]);
  await touch(tx, draft);
  return { ok: true };
}

/** A negotiated fee: the regular fee is replaced and the reason is mandatory. */
export async function setNegotiatedFee(tx: Tx, draft: LockedDraft, body: any): Promise<{ ok: true } | DraftRefusal> {
  if (draft.membership_plan_id == null) return { kind: 'invalid', message: 'A ProductSet without a Membership Plan has no Membership Fee' };
  const price = Number(body?.membership_fee_price);
  if (!Number.isFinite(price) || price < 0) return { kind: 'invalid', message: 'membership_fee_price must be a non-negative number' };
  const reason = typeof body?.discount_reason === 'string' ? body.discount_reason.trim() : '';
  if (!reason) return { kind: 'invalid', message: 'discount_reason is required for a negotiated fee' };
  const expires = body?.discount_expires_at;
  if (expires != null && expires !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(expires))) {
    return { kind: 'invalid', message: 'discount_expires_at must be YYYY-MM-DD' };
  }
  await tx.query(
    `UPDATE product_set_plan_snapshots
        SET membership_fee_price = ?, discount_reason = ?, discount_expires_at = ?
      WHERE product_set_id = ? AND gym_id = ?`,
    [price, reason, expires ? String(expires) : null, draft.id, draft.gym_id]);
  await touch(tx, draft);
  return { ok: true };
}

export async function setFeeBenefit(tx: Tx, draft: LockedDraft, body: any): Promise<{ ok: true } | DraftRefusal> {
  if (draft.membership_plan_id == null) return { kind: 'invalid', message: 'A ProductSet without a Membership Plan has no Membership Fee' };
  const action = body?.action;
  if (!isPersonalFeeBenefitAction(action)) {
    return { kind: 'invalid', message: `action must be one of: ${PERSONAL_FEE_BENEFIT_ACTIONS.join(', ')}` };
  }
  let value: number | null = null;
  if (action === 'percentage_discount') {
    const raw = Number(body?.value);
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) return { kind: 'invalid', message: 'value must be a percentage between 0 and 100' };
    value = Math.round(raw * 100) / 100;
  }
  await tx.query(
    `UPDATE product_set_plan_snapshots SET personal_fee_benefit_action = ?, personal_fee_benefit_value = ?
      WHERE product_set_id = ? AND gym_id = ?`,
    [action, value, draft.id, draft.gym_id]);
  await touch(tx, draft);
  return { ok: true };
}

/* ── Additional recurring services ───────────────────────────────────────── */

export async function addService(tx: Tx, draft: LockedDraft, body: any): Promise<{ ok: true; id: number } | DraftRefusal> {
  const productId = Number(body?.product_id);
  if (!Number.isInteger(productId) || productId <= 0) return { kind: 'invalid', message: 'product_id must be a positive integer' };
  const quantity = body?.quantity == null || body.quantity === '' ? 1 : Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) return { kind: 'invalid', message: 'quantity must be a positive integer' };
  const startsAt = body?.starts_at == null || body.starts_at === '' ? draft.starts_at : String(body.starts_at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsAt)) return { kind: 'invalid', message: 'starts_at must be YYYY-MM-DD' };

  const { rows } = await tx.query<any>(
    `SELECT id, type, billing_frequency, status FROM products WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [productId, draft.gym_id]);
  if (!rows[0]) return { kind: 'invalid', message: 'Product not found in this gym' };
  if (rows[0].status !== 'active') return { kind: 'invalid', message: 'Product is not active in this gym' };
  if (classifyProduct(rows[0]) !== 'periodical') {
    return { kind: 'invalid', message: 'Only a recurring Product can be attached as an Additional Periodic Service' };
  }
  const { rows: dup } = await tx.query(
    'SELECT id FROM user_membership_services WHERE gym_id = ? AND product_set_id = ? AND product_id = ? AND ends_at IS NULL',
    [draft.gym_id, draft.id, productId]);
  if (dup.length > 0) return { kind: 'invalid', message: 'This service is already attached to the ProductSet' };

  const { insertId } = await tx.query(
    `INSERT INTO user_membership_services
       (gym_id, product_set_id, product_id, quantity, starts_at, item_name, item_type, unit_price, item_billing_frequency, currency)
     SELECT ?, ?, gc.id, ?, ?, ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR}, COALESCE(gc.amount, 0), gc.billing_frequency, gc.currency
       FROM products gc LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
      WHERE gc.id = ? AND gc.gym_id = ?`,
    [draft.gym_id, draft.id, quantity, startsAt, productId, draft.gym_id]);
  await touch(tx, draft);
  return { ok: true, id: Number(insertId) };
}

export async function removeService(tx: Tx, draft: LockedDraft, serviceId: number): Promise<{ ok: true } | DraftRefusal> {
  // A Draft has billed nothing, so a removed service is deleted outright.
  const { rowCount } = await tx.query(
    'DELETE FROM user_membership_services WHERE id = ? AND gym_id = ? AND product_set_id = ?',
    [serviceId, draft.gym_id, draft.id]);
  if (rowCount === 0) return { kind: 'not_found' };
  await touch(tx, draft);
  return { ok: true };
}

/* ── Covered members ─────────────────────────────────────────────────────── */

const memberLimit = (limit: string | null | undefined): number =>
  limit === 'family' ? Infinity : Math.max(1, parseInt(limit ?? '1', 10) || 1);

export async function addCoveredMember(tx: Tx, draft: LockedDraft, memberId: number): Promise<{ ok: true } | DraftRefusal> {
  if (draft.membership_plan_id == null) return { kind: 'invalid', message: 'A ProductSet without a Membership Plan covers no one' };
  if (!Number.isInteger(memberId) || memberId <= 0) return { kind: 'invalid', message: 'member_id must be a positive integer' };
  const { rows: m } = await tx.query('SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL', [memberId, draft.gym_id]);
  if (m.length === 0) return { kind: 'invalid', message: 'Member not found' };
  const { rows: plan } = await tx.query<{ member_limit: string | null }>(
    'SELECT member_limit FROM membership_plans WHERE id = ? AND gym_id = ?', [draft.membership_plan_id, draft.gym_id]);
  // The owner always counts as one covered Member, whether or not their own row
  // has been written yet (the projection inserts it at activation).
  const { rows: count } = await tx.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM product_set_members WHERE gym_id = ? AND root_product_set_id = ? AND is_owner = 0',
    [draft.gym_id, draft.root_product_set_id]);
  if (Number(count[0].n) + 1 >= memberLimit(plan[0]?.member_limit)) {
    return { kind: 'invalid', message: 'This Membership Plan covers no more Members' };
  }
  // #956 Q4: a Member already on a plan of their own (or covered by another)
  // cannot be added to a second one.
  const { rows: held } = await tx.query(
    `SELECT 1 FROM product_set_members psm
       JOIN product_sets ps ON ps.root_product_set_id = psm.root_product_set_id AND ps.status = 'active'
      WHERE psm.gym_id = ? AND psm.member_id = ? AND psm.root_product_set_id <> ? LIMIT 1`,
    [draft.gym_id, memberId, draft.root_product_set_id]);
  if (held.length > 0) return { kind: 'invalid', message: 'This Member already holds a Membership Plan' };
  await tx.query(
    `INSERT IGNORE INTO product_set_members (gym_id, root_product_set_id, member_id, is_owner) VALUES (?, ?, ?, 0)`,
    [draft.gym_id, draft.root_product_set_id, memberId]);
  await touch(tx, draft);
  return { ok: true };
}

export async function removeCoveredMember(tx: Tx, draft: LockedDraft, memberId: number): Promise<{ ok: true } | DraftRefusal> {
  if (memberId === draft.owner_member_id) return { kind: 'invalid', message: 'The owner cannot be removed' };
  const { rowCount } = await tx.query(
    'DELETE FROM product_set_members WHERE gym_id = ? AND root_product_set_id = ? AND member_id = ? AND is_owner = 0',
    [draft.gym_id, draft.root_product_set_id, memberId]);
  if (rowCount === 0) return { kind: 'not_found' };
  await touch(tx, draft);
  return { ok: true };
}
