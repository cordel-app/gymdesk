import { parseLineDirectDiscountInput } from '../domain/lineDirectDiscount';
import { db, Tx } from '../infra/db';
import { syncProductSnapshotsOfVersion } from './product-snapshot-sync';
import { classifyProduct, isRecurringFrequency, ProductBenefitCategory } from '../domain/productClassification';
import { ProductBenefit, parseProductBenefitInput } from '../domain/productBenefitActions';
import { SessionBenefitFrequency, parseSessionBenefitFrequencyInput } from '../domain/sessionBenefitFrequency';
import { parsePlanBenefitMandatoryInput } from '../domain/planBenefitMandatory';
import { isPersonalFeeBenefitAction, PERSONAL_FEE_BENEFIT_ACTIONS } from '../domain/personalFeeBenefit';
import { isAcceptedPlanCadence, describeAcceptedPlanCadences } from '../domain/planBillingFrequency';
import { touchDraft } from './product-sets';
import { ownPlanSnapshot, ownPrimaryPlanSnapshot } from './plan-snapshot-ownership';
import { PLAN_LINE_CATEGORIES, PLAN_LINE_TABLE, planSnapshotInheritedSql, planSnapshotOfAssignment, planSnapshotSharedSql, primaryPlanSnapshotId, primaryPlanSnapshotSql, setOwnerIsBeneficiary } from './plan-snapshot-lines';
import { allocateItemSchedules } from './product-set-configuration';
import { loadPaidThroughForSchedule } from './cancellation-entitlement';
import { violatesOnePerMember, ONE_PER_MEMBER_MESSAGE } from './one-per-member';
import { AssigneeRefused, resolveAssignedMember } from './product-assignee';
import { insertSiblingLine, syncPlanLineAllocations } from './plan-line-allocation';
import { loadPlanAssigneeContext } from './plan-unit-assignees';
import { parsePlanLineMemberInput, planLineKey } from '../domain/planLineAllocation';

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


export type DraftRefusal =
  | { kind: 'not_found' }
  | { kind: 'not_a_draft'; status: string }
  | { kind: 'expired' }
  | { kind: 'invalid'; message: string }
  /** A 409 with a code the client recognises (#956's `active_plan_exists`). */
  | { kind: 'conflict'; error: string; message: string };

export interface LockedDraft {
  id: number;
  gym_id: string;
  owner_member_id: number;
  membership_plan_id: number | null;
  previous_product_set_id: number | null;
  starts_at: string;
}

const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/** Locks the Draft; the caller's edit then cannot race a commit or a cancel. */
export async function lockDraft(tx: Tx, gymId: string, id: number): Promise<LockedDraft | DraftRefusal> {
  const { rows } = await tx.query<any>(
    `SELECT id, gym_id, owner_member_id, previous_product_set_id, membership_plan_id, starts_at, status,
            (status = 'draft' AND last_activity_at < UTC_TIMESTAMP() - INTERVAL 120 MINUTE) AS expired
       FROM product_sets WHERE id = ? AND gym_id = ? FOR UPDATE`,
    [id, gymId],
  );
  const r = rows[0];
  if (!r) return { kind: 'not_found' };
  if (r.status !== 'draft') return { kind: 'not_a_draft', status: String(r.status) };
  if (Number(r.expired) === 1) return { kind: 'expired' };
  // #2125 M4b-2: locking copies nothing. A plan snapshot another set shares stays shared until a writer
  // edits that plan, which owns it (`ownPlanSnapshot()`) right before its write — so a Draft that reuses
  // an unmodified plan keeps linking the active set's snapshot, and only the plan being edited is copied.
  return {
    id: Number(r.id), gym_id: String(r.gym_id), owner_member_id: Number(r.owner_member_id),
    membership_plan_id: r.membership_plan_id != null ? Number(r.membership_plan_id) : null,
    previous_product_set_id: r.previous_product_set_id != null ? Number(r.previous_product_set_id) : null, starts_at: dateOnly(r.starts_at),
  };
}

export const isRefusal = (v: LockedDraft | DraftRefusal): v is DraftRefusal => 'kind' in v;

/**
 * #1187, on a version's own rows: a catalogue-mandatory line's quantity is the
 * number of Members the version covers — owner included, never below one —
 * and it *replaces* the configured quantity. Re-derived on every Draft write
 * (a section save, a coverage change), so no writer can leave it stale. Since
 * #2657 stage 3 an Individual Product is one line per member, so the same pass
 * splits a line still carrying no member and gives a catalogue-mandatory
 * Individual Product one unit per beneficiary (`syncPlanLineAllocations()`).
 */
export async function syncMandatoryQuantities(
  tx: Tx, gymId: string, productSetId: number,
): Promise<void> {
  await syncPlanLineAllocations(tx, gymId, productSetId);
}

async function touch(tx: Tx, draft: LockedDraft) {
  await touchDraft(tx, draft.gym_id, draft.id);
  await syncMandatoryQuantities(tx, draft.gym_id, draft.id);
  await syncProductSnapshotsOfVersion(tx, draft.gym_id, draft.id);
}

const ITEM_NAME_EXPR = "COALESCE(gc.name, ct.name, CONCAT('Product #', gc.id))";
const ITEM_TYPE_EXPR = "COALESCE(gc.type, 'other')";

/* ── Benefit sections ────────────────────────────────────────────────────── */

/**
 * #2624 stage 2 — the refusal a section write gets when it would drop a Mandatory
 * line, or turn one Optional, or `null` when every Mandatory line survives as it is.
 * Pure: `current` is what the plan snapshot holds, `next` what the request keeps.
 */
export function mandatoryLineRefusal(
  current: { product_id: number; assigned_member_id?: number | null; mandatory: boolean; item_name: string }[],
  next: { product_id: number; assigned_member_id?: number | null; mandatory?: boolean }[],
): string | null {
  // #2657 stage 3: a line is its Product and the member it is for, so dropping one
  // member's Mandatory line is a removal too.
  const byKey = new Map(next.map((n) => [planLineKey(n.product_id, n.assigned_member_id), n]));
  for (const line of current) {
    if (!line.mandatory) continue;
    const kept = byKey.get(planLineKey(line.product_id, line.assigned_member_id));
    if (!kept) return `'${line.item_name}' is a Mandatory product of this plan and cannot be removed`;
    if (kept.mandatory === false) return `'${line.item_name}' is a Mandatory product of this plan and cannot be made optional`;
  }
  return null;
}

export async function loadBenefitSection(gymId: string, productSetId: number, category: ProductBenefitCategory) {
  const snapshotId = await primaryPlanSnapshotId(db, gymId, productSetId);
  if (snapshotId == null) return [];
  const { rows } = await db.query<any>(
    `SELECT product_id, assigned_member_id, quantity, item_name, item_type, item_billing_frequency, unit_price, currency,
            \`action\`, \`value\`, mandatory${category === 'session' ? ', frequency' : ''}
       FROM ${PLAN_LINE_TABLE[category]} WHERE gym_id = ? AND plan_snapshot_id = ? ORDER BY id`,
    [gymId, snapshotId]);
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
  // #2093 stage 2: the line's own treatment, renewal Frequency and Mandatory
  // flag travel under the Plan editor's rule — a key the request does not name
  // keeps what the line is stored with, so a quantity-only client is unchanged.
  type Parsed = {
    product_id: number; quantity: number;
    /** #2657 stage 3: `undefined` = not named, `null` = the unsplit line, a number = that member's line. */
    member?: number | null;
    benefit: ProductBenefit | null;
    frequency?: SessionBenefitFrequency | null;
    mandatory?: boolean;
    direct_discount_percent?: number | null;
  };
  const parsed: Parsed[] = [];
  for (const item of items) {
    const productId = Number((item as any)?.product_id);
    const quantity = Number((item as any)?.quantity);
    if (!Number.isInteger(productId) || productId <= 0) return { kind: 'invalid', message: 'product_id is required' };
    if (!Number.isInteger(quantity) || quantity <= 0) return { kind: 'invalid', message: 'quantity must be a positive integer' };
    const memberInput = parsePlanLineMemberInput(item);
    if ('error' in memberInput) return { kind: 'invalid', message: memberInput.error };
    const pair = parseProductBenefitInput('plan', item as any);
    if (pair.error) return { kind: 'invalid', message: pair.error };
    const frequency = category === 'session' ? parseSessionBenefitFrequencyInput(item) : { keep: true as const };
    if ('error' in frequency && frequency.error) return { kind: 'invalid', message: frequency.error };
    const mandatoryInput = parsePlanBenefitMandatoryInput(item);
    if (mandatoryInput.error) return { kind: 'invalid', message: mandatoryInput.error };
    const directInput = parseLineDirectDiscountInput(item);
    if (directInput.error) return { kind: 'invalid', message: directInput.error };
    parsed.push({
      product_id: productId, quantity, benefit: pair.benefit,
      ...(memberInput.keep ? {} : { member: memberInput.memberId }),
      ...(frequency.keep ? {} : { frequency: (frequency as any).frequency }),
      ...(mandatoryInput.keep ? {} : { mandatory: mandatoryInput.mandatory }),
      ...(directInput.keep ? {} : { direct_discount_percent: directInput.percent }),
    });
  }

  const table = PLAN_LINE_TABLE[category];
  const snapshotId = await primaryPlanSnapshotId(tx, draft.gym_id, draft.id);
  if (snapshotId == null) return { kind: 'invalid', message: 'This version has no Membership Plan to configure' };
  const { rows: currentRaw } = await tx.query<{
    id: number; product_id: number; assigned_member_id: number | null; mandatory: number; item_name: string; sharing_type: string | null;
  }>(
    `SELECT b.id, b.product_id, b.assigned_member_id, b.mandatory, b.item_name, gc.sharing_type
       FROM ${table} b LEFT JOIN products gc ON gc.id = b.product_id AND gc.gym_id = b.gym_id
      WHERE b.gym_id = ? AND b.plan_snapshot_id = ? ORDER BY b.id`,
    [draft.gym_id, snapshotId]);
  const current = currentRaw.map((r) => ({
    ...r, id: Number(r.id), product_id: Number(r.product_id),
    assigned_member_id: r.assigned_member_id == null ? null : Number(r.assigned_member_id),
  }));

  // #2657 stage 3: each item names one line — its Product and, for an Individual Product held
  // per member, the member it is for. An item naming no member matches the Product's only line;
  // a Product held by several members needs the member, never a guess.
  type Resolved = Parsed & { lineId: number | null; memberId: number | null };
  const resolved: Resolved[] = [];
  const seen = new Set<string>();
  for (const p of parsed) {
    const ofProduct = current.filter((c) => c.product_id === p.product_id);
    let line: (typeof current)[number] | undefined;
    if (p.member !== undefined) {
      line = ofProduct.find((c) => c.assigned_member_id === p.member);
    } else if (ofProduct.length > 1) {
      return { kind: 'invalid', message: `assigned_member_id is required: '${ofProduct[0].item_name}' is held per member` };
    } else {
      line = ofProduct[0];
    }
    const memberId = line ? line.assigned_member_id : (p.member ?? null);
    const key = planLineKey(p.product_id, memberId);
    if (seen.has(key)) return { kind: 'invalid', message: `Duplicate line: product_id ${p.product_id}` };
    seen.add(key);
    resolved.push({ ...p, lineId: line ? line.id : null, memberId });
  }

  // #2624 stage 2 (§4): only an Optional line may leave the plan, and a Mandatory
  // line cannot be made Optional here either (that would be the same removal in
  // two requests). The flag is the Plan's, frozen with the line (#1184).
  const locked = mandatoryLineRefusal(
    current.map((r) => ({ product_id: r.product_id, assigned_member_id: r.assigned_member_id, mandatory: Number(r.mandatory) === 1, item_name: r.item_name })),
    resolved.map((r) => ({ product_id: r.product_id, assigned_member_id: r.memberId, mandatory: r.mandatory })),
  );
  if (locked) return { kind: 'conflict', error: 'mandatory_line_not_removable', message: locked };

  const attached = new Set(current.map((r) => r.product_id));
  const added = [...new Set(resolved.filter((p) => !attached.has(p.product_id)).map((p) => p.product_id))];
  const sharing = new Map(current.map((c) => [c.product_id, c.sharing_type]));
  if (added.length > 0) {
    const { rows: products } = await tx.query<any>(
      `SELECT id, type, billing_frequency, status, sharing_type FROM products
        WHERE gym_id = ? AND deleted_at IS NULL AND id IN (${added.map(() => '?').join(',')})`,
      [draft.gym_id, ...added]);
    if (products.length !== added.length) return { kind: 'invalid', message: 'One or more Products not found in this gym' };
    const inactive = products.find((p: any) => p.status !== 'active');
    if (inactive) return { kind: 'invalid', message: `Product ${inactive.id} is not active in this gym` };
    const mismatched = products.find((p: any) => classifyProduct(p) !== category);
    if (mismatched) return { kind: 'invalid', message: `Product ${mismatched.id} does not belong in the '${category}' category` };
    for (const p of products) sharing.set(Number(p.id), p.sharing_type);
  }
  // A new member line: only an Individual Product is held per member, and only by someone the plan
  // may give it to (the owner, their family or a beneficiary, #2609).
  const newMemberLines = resolved.filter((r) => r.lineId == null && r.memberId != null);
  if (newMemberLines.length > 0) {
    const ctx = await loadPlanAssigneeContext(tx, draft.gym_id, snapshotId);
    const eligible = new Set((ctx?.eligible ?? []).map((e) => e.member_id));
    for (const r of newMemberLines) {
      if (sharing.get(r.product_id) === 'shared') return { kind: 'invalid', message: 'A shared product is not assigned to one family member' };
      if (!eligible.has(r.memberId as number)) {
        return { kind: 'invalid', message: 'Each line must be for the plan owner or a member of their family' };
      }
    }
  }

  // M4b-2: the plan is being edited, so the Draft takes its own copy of it now (a no-op unless shared).
  const target = await ownPlanSnapshot(tx, draft.gym_id, draft.id, snapshotId);
  // A copy-on-write gives every line a new id; the lines are matched again by their key.
  const lineIdOf = new Map<string, number>();
  {
    const { rows } = await tx.query<{ id: number; product_id: number; assigned_member_id: number | null }>(
      `SELECT id, product_id, assigned_member_id FROM ${table} WHERE gym_id = ? AND plan_snapshot_id = ?`,
      [draft.gym_id, target]);
    for (const r of rows) lineIdOf.set(planLineKey(Number(r.product_id), r.assigned_member_id == null ? null : Number(r.assigned_member_id)), Number(r.id));
  }
  const keptIds = resolved.filter((r) => r.lineId != null)
    .map((r) => lineIdOf.get(planLineKey(r.product_id, r.memberId)) as number);
  if (keptIds.length === 0) {
    await tx.query(`DELETE FROM ${table} WHERE gym_id = ? AND plan_snapshot_id = ?`, [draft.gym_id, target]);
  } else {
    await tx.query(
      `DELETE FROM ${table} WHERE gym_id = ? AND plan_snapshot_id = ? AND id NOT IN (${keptIds.map(() => '?').join(',')})`,
      [draft.gym_id, target, ...keptIds]);
  }
  for (const p of resolved) {
    // Columns this line's request named; everything else is left as stored.
    const extra: string[] = [];
    const extraParams: unknown[] = [];
    if (p.benefit) { extra.push('`action` = ?', '`value` = ?'); extraParams.push(p.benefit.action, p.benefit.value); }
    if (p.frequency !== undefined) { extra.push('frequency = ?'); extraParams.push(p.frequency); }
    if (p.mandatory !== undefined) { extra.push('mandatory = ?'); extraParams.push(p.mandatory ? 1 : 0); }
    if (p.direct_discount_percent !== undefined) { extra.push('direct_discount_percent = ?'); extraParams.push(p.direct_discount_percent); }
    if (p.lineId != null) {
      await tx.query(
        `UPDATE ${table} SET quantity = ?${extra.length ? ', ' + extra.join(', ') : ''} WHERE id = ?`,
        [p.quantity, ...extraParams, lineIdOf.get(planLineKey(p.product_id, p.memberId))]);
      continue;
    }
    let newId: number;
    const sibling = [...lineIdOf].find(([k]) => k.startsWith(`${p.product_id}:`))?.[1];
    if (sibling != null) {
      // Another member's line of the same Product: the new member's line is agreed on the same
      // frozen facts (price, treatment, Mandatory flag), never re-read from the catalogue.
      newId = await insertSiblingLine(tx, category, sibling, p.memberId, p.quantity);
    } else {
      const { insertId } = await tx.query(
        `INSERT INTO ${table}
           (gym_id, plan_snapshot_id, product_id, quantity, item_name, item_type, item_billing_frequency, unit_price, currency, assigned_member_id)
         SELECT ?, ?, gc.id, ?, ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR}, gc.billing_frequency, COALESCE(gc.amount, 0), gc.currency, ?
           FROM products gc LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
          WHERE gc.id = ? AND gc.gym_id = ?`,
        [draft.gym_id, target, p.quantity, p.memberId, p.product_id, draft.gym_id]);
      newId = Number(insertId);
      // #2624 stage 2: a line staff add to this configuration is not one of the
      // Plan's, so it is Optional (removable) unless the request says otherwise.
      if (p.mandatory === undefined) await tx.query(`UPDATE ${table} SET mandatory = 0 WHERE id = ?`, [newId]);
    }
    lineIdOf.set(planLineKey(p.product_id, p.memberId), newId);
    if (extra.length) await tx.query(`UPDATE ${table} SET ${extra.join(', ')} WHERE id = ?`, [...extraParams, newId]);
  }
  await allocateItemSchedules(tx, draft.gym_id, draft.id);
  await touch(tx, draft);
  return { ok: true };
}

/* ── Plan snapshot fields ────────────────────────────────────────────────── */

/** `null` / `''` clears the field (stored NULL, as the assignment snapshot reads it). */
const nonNegInt = (v: unknown): number | null | false => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : false;
};

export async function setBillingDuration(tx: Tx, draft: LockedDraft, body: any): Promise<{ ok: true } | DraftRefusal> {
  if (draft.membership_plan_id == null) return { kind: 'invalid', message: 'A ProductSet without a Membership Plan has no Billing & Duration' };
  const patch: Record<string, number | null> = {};
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
    `SELECT paid_periods, pay_beforehand_periods FROM plan_snapshots WHERE id = ${primaryPlanSnapshotSql('?', '?')} FOR UPDATE`,
    [draft.id, draft.gym_id]);
  if (!rows[0]) return { kind: 'invalid', message: 'This ProductSet has no plan snapshot' };
  const paid = 'paid_periods' in patch ? Number(patch.paid_periods ?? 0) : Number(rows[0].paid_periods ?? 0);
  const prepaid = 'pay_beforehand_periods' in patch ? Number(patch.pay_beforehand_periods ?? 0) : Number(rows[0].pay_beforehand_periods ?? 0);
  if (prepaid > paid) return { kind: 'invalid', message: 'pay_beforehand_periods cannot exceed paid_periods' };

  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
  const target = await ownPrimaryPlanSnapshot(tx, draft.gym_id, draft.id);
  await tx.query(`UPDATE plan_snapshots SET ${sets} WHERE id = ? AND gym_id = ?`,
    [...Object.values(patch), target, draft.gym_id]);
  await touch(tx, draft);
  return { ok: true };
}

/**
 * #1949 — the Billing frequency of a **first** Draft version. Its plan schedule
 * was created with the Draft and has no events or other version behind it, so the
 * cadence can still move with the snapshot (only a schedule this Draft opened,
 * `opened_by_product_set_id`). A Product Set that follows another keeps the
 * owner's schedule (never re-anchored), so there the cadence stays fixed.
 */
export async function setBillingCadence(tx: Tx, draft: LockedDraft, body: any): Promise<{ ok: true } | DraftRefusal> {
  if (draft.membership_plan_id == null) return { kind: 'invalid', message: 'A ProductSet without a Membership Plan has no Billing & Duration' };
  if (draft.previous_product_set_id != null) {
    // #1982 — the editor saves every Billing & Duration field, so a pair that is
    // not being changed is not a refusal; only an actual change on a later
    // version (which shares the chain's schedule) is.
    const { rows: cur } = await tx.query<any>(
      `SELECT recurring_billing_interval, recurring_billing_unit FROM plan_snapshots WHERE id = ${primaryPlanSnapshotSql('?', '?')}`,
      [draft.id, draft.gym_id]);
    const sameInterval = cur[0] && Number(cur[0].recurring_billing_interval) === Number(body?.recurring_billing_interval);
    const sameUnit = cur[0] && (cur[0].recurring_billing_unit ?? null) === (body?.recurring_billing_unit ?? null);
    if (sameInterval && sameUnit) return { ok: true };
    return { kind: 'invalid', message: 'recurring_billing_interval cannot be changed on a plan billed from a ProductSet; assign a new plan' };
  }
  const interval = Number(body?.recurring_billing_interval);
  const unit = body?.recurring_billing_unit;
  if (!isAcceptedPlanCadence(interval, unit)) {
    return { kind: 'invalid', message: `Billing frequency must be one of: ${describeAcceptedPlanCadences()}` };
  }
  const { rows } = await tx.query<any>(
    `SELECT schedule_id FROM plan_snapshots WHERE id = ${primaryPlanSnapshotSql('?', '?')} FOR UPDATE`,
    [draft.id, draft.gym_id]);
  if (!rows[0]) return { kind: 'invalid', message: 'This ProductSet has no plan snapshot' };
  const target = await ownPrimaryPlanSnapshot(tx, draft.gym_id, draft.id);
  await tx.query(
    'UPDATE plan_snapshots SET recurring_billing_interval = ?, recurring_billing_unit = ? WHERE id = ? AND gym_id = ?',
    [interval, unit, target, draft.gym_id]);
  if (rows[0].schedule_id != null) {
    await tx.query(
      'UPDATE product_set_schedules SET cadence_interval = ?, cadence_unit = ? WHERE id = ? AND gym_id = ? AND opened_by_product_set_id = ?',
      [interval, unit, rows[0].schedule_id, draft.gym_id, draft.id]);
  }
  await touch(tx, draft);
  return { ok: true };
}

/**
 * The agreed Membership Fee of the version (what the Admin's Billing & Duration
 * editor writes as `membership_fee_price`): the price alone, the stored reason
 * left as it is — a negotiated fee with its reason is `setNegotiatedFee()`.
 */
export async function setMembershipFeePrice(tx: Tx, draft: LockedDraft, raw: unknown): Promise<{ ok: true } | DraftRefusal> {
  if (draft.membership_plan_id == null) return { kind: 'invalid', message: 'A ProductSet without a Membership Plan has no Membership Fee' };
  const price = raw === null || raw === '' ? null : Number(raw);
  if (price != null && (!Number.isFinite(price) || price < 0)) {
    return { kind: 'invalid', message: 'membership_fee_price must be a non-negative number' };
  }
  const target = await ownPrimaryPlanSnapshot(tx, draft.gym_id, draft.id);
  if (target == null) return { kind: 'invalid', message: 'This ProductSet has no plan snapshot' };
  await tx.query('UPDATE plan_snapshots SET membership_fee_price = ? WHERE id = ? AND gym_id = ?',
    [price, target, draft.gym_id]);
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
  const target = await ownPrimaryPlanSnapshot(tx, draft.gym_id, draft.id);
  if (target == null) return { kind: 'invalid', message: 'This ProductSet has no plan snapshot' };
  await tx.query(
    `UPDATE plan_snapshots
        SET membership_fee_price = ?, discount_reason = ?, discount_expires_at = ?
      WHERE id = ? AND gym_id = ?`,
    [price, reason, expires ? String(expires) : null, target, draft.gym_id]);
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
    if (body?.value == null || body.value === '') return { kind: 'invalid', message: 'value is required for a percentage discount' };
    const raw = Number(body.value);
    if (!Number.isFinite(raw) || raw < 0 || raw > 100) return { kind: 'invalid', message: 'value must be a percentage between 0 and 100' };
    value = Math.round(raw * 100) / 100;
  }
  const target = await ownPrimaryPlanSnapshot(tx, draft.gym_id, draft.id);
  if (target == null) return { kind: 'invalid', message: 'This ProductSet has no plan snapshot' };
  await tx.query(
    `UPDATE plan_snapshots SET personal_fee_benefit_action = ?, personal_fee_benefit_value = ?
      WHERE id = ? AND gym_id = ?`,
    [action, value, target, draft.gym_id]);
  await touch(tx, draft);
  return { ok: true };
}

/* ── Additional recurring services ───────────────────────────────────────── */

/** #1865 — an identical purchase line younger than this is a double submission, not a repeat purchase. */
const DUPLICATE_SUBMISSION_SECONDS = 10;

/**
 * `legacy` is the contract of `/user-memberships/:id/services` (a duplicate is a
 * 409, a removal keeps what was already billed); the Draft router's own is a
 * 400 and an outright deletion, since a Draft has charged nothing.
 */
export async function addService(
  tx: Tx, draft: LockedDraft, body: any, opts: { legacy?: boolean; recurringByFrequency?: boolean; allowRepeat?: boolean } = {},
): Promise<{ ok: true; id: number } | DraftRefusal> {
  const productId = Number(body?.product_id);
  if (!Number.isInteger(productId) || productId <= 0) return { kind: 'invalid', message: 'product_id must be a positive integer' };
  const quantity = body?.quantity == null || body.quantity === '' ? 1 : Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) return { kind: 'invalid', message: 'quantity must be a positive integer' };

  // A service can never be billed before the plan it belongs to: by default it
  // starts today, or on the plan's start date when that is still ahead.
  const today = new Date().toISOString().slice(0, 10);
  const startsAt = body?.starts_at == null || body.starts_at === ''
    ? (today > draft.starts_at ? today : draft.starts_at)
    : String(body.starts_at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsAt)) return { kind: 'invalid', message: 'starts_at must be YYYY-MM-DD' };
  if (startsAt < draft.starts_at) {
    return { kind: 'invalid', message: 'starts_at cannot be earlier than the Assigned Plan start date' };
  }
  const { rows: window } = await tx.query<any>('SELECT ends_at FROM product_sets WHERE id = ? AND gym_id = ?', [draft.id, draft.gym_id]);
  const endsAt = window[0]?.ends_at != null ? dateOnly(window[0].ends_at) : null;
  if (endsAt != null && startsAt > endsAt) {
    return { kind: 'invalid', message: 'starts_at cannot be later than the Assigned Plan end date' };
  }

  const { rows } = await tx.query<any>(
    `SELECT id, type, billing_frequency, status FROM products WHERE id = ? AND gym_id = ? AND deleted_at IS NULL`,
    [productId, draft.gym_id]);
  if (!rows[0]) return { kind: 'not_found' };
  if (rows[0].status !== 'active') return { kind: 'invalid', message: 'Product is not active' };
  // A staff purchase decides "recurring" by the Product's billing frequency
  // (the route's own rule), so a `sessions` Product billed monthly (a Duo
  // class) is a recurring line too; the plan-benefit screens keep the section
  // classification.
  const recurringLine = classifyProduct(rows[0]) === 'periodical'
    || (opts.recurringByFrequency === true && isRecurringFrequency(rows[0].billing_frequency));
  if (!recurringLine) {
    return { kind: 'invalid', message: 'Only recurring Products can be added as periodic services' };
  }
  // The same item may be attached again after an earlier stint ended, but not
  // while one is still running or one still ends on/after the requested start —
  // except for a purchase (`allowRepeat`, #1865 stage 2): buying the same
  // recurring Product again is a line of its own, with its own price, discount
  // and lifecycle. What a repeat must not be is an accident, so a line of this
  // Product written a moment ago (a clone carries another id than its `line_ref`, so only a
  // line bought in this Draft counts) (a double-clicked button, a retried request) is
  // still refused.
  //
  // #2126 stage 3l: both guards read the Product snapshot of each line, keyed
  // back to the legacy line by `source_id`. They run before the line they guard
  // is written, so every line they read was synced by an earlier Draft write.
  if (opts.allowRepeat) {
    const { rows: recent } = await tx.query(
      `SELECT source_id AS id FROM product_periodical_snapshots
        WHERE gym_id = ? AND product_set_id = ? AND product_id = ? AND ends_at IS NULL
          AND line_ref = source_id AND created_at > (UTC_TIMESTAMP() - INTERVAL ${DUPLICATE_SUBMISSION_SECONDS} SECOND)`,
      [draft.gym_id, draft.id, productId]);
    if (recent.length > 0) {
      const message = 'This product was just added; wait a moment before adding it again';
      return { kind: 'conflict', error: 'duplicate_submission', message };
    }
  } else {
    const { rows: dup } = await tx.query(
      `SELECT source_id AS id FROM product_periodical_snapshots
        WHERE gym_id = ? AND product_set_id = ? AND product_id = ? AND (ends_at IS NULL OR ends_at >= ?)`,
      [draft.gym_id, draft.id, productId, startsAt]);
    if (dup.length > 0) {
      const message = 'This service is already attached to the Assigned Plan for that period';
      return opts.legacy ? { kind: 'conflict', error: message, message } : { kind: 'invalid', message };
    }
  }

  // #2607: One per Member — refused on every path that attaches a recurring line.
  if (await violatesOnePerMember(tx, draft.gym_id, draft.owner_member_id, productId, { draftSetId: draft.id })) {
    const message = ONE_PER_MEMBER_MESSAGE;
    return opts.legacy ? { kind: 'conflict', error: message, message } : { kind: 'conflict', error: 'one_per_member', message };
  }

  // #2609: who the line is for — the owner, or a member of their family; nothing for a shared Product.
  let assignedMemberId: number | null;
  try {
    assignedMemberId = await resolveAssignedMember(tx, draft.gym_id, draft.owner_member_id, productId, body?.assigned_member_id);
  } catch (err) {
    if (err instanceof AssigneeRefused) return { kind: 'invalid', message: err.message };
    throw err;
  }

  const { insertId } = await tx.query(
    `INSERT INTO member_products_recurrent_snapshot
       (gym_id, product_set_id, product_id, quantity, starts_at, item_name, item_type, unit_price, item_billing_frequency, currency, origin, assigned_member_id)
     SELECT ?, ?, gc.id, ?, ?, ${ITEM_NAME_EXPR}, ${ITEM_TYPE_EXPR}, COALESCE(gc.amount, 0), gc.billing_frequency, gc.currency, 'admin', ?
       FROM products gc LEFT JOIN charge_types ct ON ct.id = gc.charge_type_id
      WHERE gc.id = ? AND gc.gym_id = ?`,
    [draft.gym_id, draft.id, quantity, startsAt, assignedMemberId, productId, draft.gym_id]);
  await tx.query('UPDATE member_products_recurrent_snapshot SET line_ref = id WHERE id = ?', [insertId]);
  await allocateItemSchedules(tx, draft.gym_id, draft.id);
  await touch(tx, draft);
  return { ok: true, id: Number(insertId) };
}

/**
 * #631 §3 — future-only removal. A service already being billed keeps every
 * charge up to today and stops afterwards (`ends_at = today`); one whose billing
 * has not started yet is deleted, since an `ends_at` before `starts_at` would
 * be meaningless. A service already removed is a 409.
 */
export async function removeService(
  tx: Tx, draft: LockedDraft, serviceId: number, opts: { legacy?: boolean } = {},
): Promise<{ ok: true; deleted: boolean; ends_at: string | null } | DraftRefusal> {
  // #2126 stage 3s — the legacy line is the writer below, so its row is locked
  // first; what the removal decides on (already removed, started, its schedule)
  // is then read from `product_periodical_snapshots`, kept equal to the line by
  // `syncProductSnapshotsOfVersion()` (every Draft writer's `touch()`, and the
  // clone that made the version).
  const { rows: locked } = await tx.query<any>(
    `SELECT id FROM member_products_recurrent_snapshot
      WHERE id = ? AND gym_id = ? AND product_set_id = ? FOR UPDATE`,
    [serviceId, draft.gym_id, draft.id]);
  if (!locked[0]) return { kind: 'not_found' };
  const { rows } = await tx.query<any>(
    `SELECT starts_at, ends_at, schedule_id FROM product_periodical_snapshots
      WHERE source_id = ? AND gym_id = ? AND product_set_id = ?`,
    [serviceId, draft.gym_id, draft.id]);
  if (!rows[0]) return { kind: 'not_found' };
  if (rows[0].ends_at != null) {
    const message = 'Service has already been removed';
    return { kind: 'conflict', error: message, message };
  }
  const today = new Date().toISOString().slice(0, 10);
  const deleted = !opts.legacy || dateOnly(rows[0].starts_at) > today;
  let endsAt = today;
  if (deleted) {
    await tx.query('DELETE FROM member_products_recurrent_snapshot WHERE id = ?', [serviceId]);
  } else {
    // #1914 — a removed line keeps what was paid for: it ends on the last day
    // of its last paid period when that is still ahead, else today.
    const paidThrough = rows[0].schedule_id != null
      ? await loadPaidThroughForSchedule(tx, draft.gym_id, Number(rows[0].schedule_id)) : null;
    endsAt = paidThrough && paidThrough > today ? paidThrough : today;
    await tx.query('UPDATE member_products_recurrent_snapshot SET ends_at = ? WHERE id = ?', [endsAt, serviceId]);
  }
  await touch(tx, draft);
  return { ok: true, deleted, ends_at: deleted ? null : endsAt };
}

/**
 * #1537 — changes the quantity of a recurring line still running on a Draft.
 * Only the number moves: the line's frozen price, its discount and its start
 * stay what the Draft was agreed with, and its schedule is re-derived.
 */
export async function setServiceQuantity(
  tx: Tx, draft: LockedDraft, serviceId: number, raw: unknown,
): Promise<{ ok: true; quantity: number } | DraftRefusal> {
  const quantity = Number(raw);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 999) {
    return { kind: 'invalid', message: 'quantity must be a positive integer' };
  }
  // #2126 stage 3s — lock the legacy line (the writer below), then read whether
  // it is still running from its synced snapshot.
  const { rows: locked } = await tx.query<any>(
    `SELECT id FROM member_products_recurrent_snapshot
      WHERE id = ? AND gym_id = ? AND product_set_id = ? FOR UPDATE`,
    [serviceId, draft.gym_id, draft.id]);
  if (!locked[0]) return { kind: 'not_found' };
  const { rows } = await tx.query<any>(
    `SELECT 1 FROM product_periodical_snapshots
      WHERE source_id = ? AND gym_id = ? AND product_set_id = ? AND ends_at IS NULL`,
    [serviceId, draft.gym_id, draft.id]);
  if (!rows[0]) return { kind: 'not_found' };
  await tx.query('UPDATE member_products_recurrent_snapshot SET quantity = ? WHERE id = ? AND gym_id = ?',
    [quantity, serviceId, draft.gym_id]);
  await allocateItemSchedules(tx, draft.gym_id, draft.id);
  await touch(tx, draft);
  return { ok: true, quantity };
}

/* ── Covered members ─────────────────────────────────────────────────────── */

const memberLimit = (limit: string | null | undefined): number =>
  limit === 'family' ? Infinity : Math.max(1, parseInt(limit ?? '1', 10) || 1);

export async function addCoveredMember(
  tx: Tx, draft: LockedDraft, memberId: number, opts: { userMembershipId?: number | null } = {},
): Promise<{ ok: true } | DraftRefusal> {
  if (draft.membership_plan_id == null) return { kind: 'invalid', message: 'A ProductSet without a Membership Plan covers no one' };
  if (!Number.isInteger(memberId) || memberId <= 0) return { kind: 'invalid', message: 'member_id must be a positive integer' };
  const { rows: m } = await tx.query('SELECT id FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL', [memberId, draft.gym_id]);
  if (m.length === 0) return { kind: 'not_found' };
  // #2125 stage 21: coverage is the plan snapshot's own, so the limit and the duplicate check are per plan.
  const snapshotId = await planSnapshotOfAssignment(tx, draft.gym_id, draft.id, opts.userMembershipId ?? null);
  if (snapshotId == null) return { kind: 'invalid', message: 'A ProductSet without a Membership Plan covers no one' };
  const { rows: plan } = await tx.query<{ member_limit: string | null }>(
    `SELECT mp.member_limit FROM plan_snapshots s JOIN membership_plans mp ON mp.id = s.membership_plan_id
      WHERE s.id = ? AND s.gym_id = ?`, [snapshotId, draft.gym_id]);
  // #2125 stage 22: the payer is a beneficiary only when the plan says so, so the limit counts the
  // beneficiaries the plan has, whoever they are.
  const { rows: count } = await tx.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM plan_snapshot_beneficiaries WHERE gym_id = ? AND plan_snapshot_id = ?',
    [draft.gym_id, snapshotId]);
  if (Number(count[0].n) >= memberLimit(plan[0]?.member_limit)) {
    return { kind: 'invalid', message: 'This membership has reached its member limit.' };
  }
  const { rows: already } = await tx.query(
    'SELECT 1 FROM plan_snapshot_beneficiaries WHERE gym_id = ? AND plan_snapshot_id = ? AND member_id = ? LIMIT 1',
    [draft.gym_id, snapshotId, memberId]);
  if (already.length > 0) {
    const message = 'This Member is already covered by this Membership.';
    return { kind: 'conflict', error: message, message };
  }
  // #2125: a Member already on a plan of their own (or covered by another) may be covered by this one
  // too; "already covered by *this* plan" above is the only duplicate a coverage change refuses.
  // M4b-2: this plan is being edited, so the Draft takes its own copy of it (a no-op unless shared).
  const target = await ownPlanSnapshot(tx, draft.gym_id, draft.id, snapshotId);
  if (memberId === draft.owner_member_id) {
    await setOwnerIsBeneficiary(tx, draft.gym_id, target, true);
  } else {
    await tx.query(
      `INSERT IGNORE INTO plan_snapshot_beneficiaries (gym_id, plan_snapshot_id, member_id, is_owner) VALUES (?, ?, ?, 0)`,
      [draft.gym_id, target, memberId]);
  }
  await touch(tx, draft);
  return { ok: true };
}

export async function removeCoveredMember(
  tx: Tx, draft: LockedDraft, memberId: number, opts: { userMembershipId?: number | null } = {},
): Promise<{ ok: true } | DraftRefusal> {
  const snapshotId = await planSnapshotOfAssignment(tx, draft.gym_id, draft.id, opts.userMembershipId ?? null);
  if (snapshotId == null) return { kind: 'not_found' };
  if (memberId === draft.owner_member_id) {
    // The payer stays the payer; only their place among the plan's beneficiaries goes (#2125 stage 22).
    const { rows: has } = await tx.query(
      'SELECT 1 FROM plan_snapshot_beneficiaries WHERE gym_id = ? AND plan_snapshot_id = ? AND member_id = ? LIMIT 1',
      [draft.gym_id, snapshotId, memberId]);
    if (has.length === 0) return { kind: 'not_found' };
    const target = await ownPlanSnapshot(tx, draft.gym_id, draft.id, snapshotId);
    await setOwnerIsBeneficiary(tx, draft.gym_id, target, false);
    await touch(tx, draft);
    return { ok: true };
  }
  const target = await ownPlanSnapshot(tx, draft.gym_id, draft.id, snapshotId);
  const { rowCount } = await tx.query(
    'DELETE FROM plan_snapshot_beneficiaries WHERE gym_id = ? AND plan_snapshot_id = ? AND member_id = ? AND is_owner = 0',
    [draft.gym_id, target, memberId]);
  if (rowCount === 0) return { kind: 'not_found' };
  await touch(tx, draft);
  return { ok: true };
}

/* ── #2496 stage 4 — the member's plan on their own Draft ─────────────────── */

/**
 * Adds the member's **first** Membership Plan to the Draft they are building in
 * the Members App, beside the recurring Products already on it, so one Draft is
 * one purchase. It is the member path's own steps (`POST /me/membership-plans/
 * :id/assign`) on an existing Draft instead of a new one: the plan frozen onto
 * the version (`snapshotProductSetFromPlan()`, at the Draft's own start), the
 * owner covered, each Promotion applied with its own snapshot. The caller has
 * already judged the plan, the Promotions and the declined benefits with the
 * same validations; this refuses only a Draft that already carries a plan,
 * because a member never adds a second plan or replaces one from the Members
 * App (#1288 §28, #2125). Nothing is priced and nothing is committed here.
 */
export async function addMemberPlanToDraft(tx: Tx, draft: LockedDraft, input: {
  membershipPlanId: number;
  membershipFeePrice: number | null;
  declinedBenefits: Array<{ section: string; product_id: number }>;
  promotionIds: readonly number[];
  actor: string | null;
}): Promise<{ ok: true; plan_snapshot_id: number } | DraftRefusal> {
  const existing = await primaryPlanSnapshotId(tx, draft.gym_id, draft.id);
  if (draft.membership_plan_id != null || existing != null) {
    return { kind: 'conflict', error: 'draft_has_plan', message: 'Your selection already includes a plan.' };
  }
  await tx.query('UPDATE product_sets SET membership_plan_id = ? WHERE id = ? AND gym_id = ?',
    [input.membershipPlanId, draft.id, draft.gym_id]);
  const { snapshotProductSetFromPlan } = await import('./product-set-configuration');
  await snapshotProductSetFromPlan(tx, {
    gymId: draft.gym_id, productSetId: draft.id, membershipPlanId: input.membershipPlanId,
    membershipFeePrice: input.membershipFeePrice, startsAt: draft.starts_at,
    declinedBenefits: input.declinedBenefits, origin: 'members_app',
  });
  const { addCoverage } = await import('./product-sets');
  await addCoverage(tx, { gymId: draft.gym_id, productSetId: draft.id, memberId: draft.owner_member_id, isOwner: true });
  const { applyPromotionToProductSet } = await import('./membership-promotions');
  for (const promotionId of input.promotionIds) {
    await applyPromotionToProductSet(tx, draft.gym_id, input.actor, draft.id, promotionId);
  }
  await touch(tx, { ...draft, membership_plan_id: input.membershipPlanId });
  const snapshotId = await primaryPlanSnapshotId(tx, draft.gym_id, draft.id);
  return { ok: true, plan_snapshot_id: Number(snapshotId) };
}

/**
 * Takes the plan back off the member's Draft: only a plan this Draft added (a
 * snapshot no other version links), with its Promotion applications. A Draft
 * has charged nothing, so the snapshot is deleted outright (its lines,
 * beneficiaries and Promotion snapshots cascade); the Products on the Draft stay.
 */
export async function removeMemberPlanFromDraft(tx: Tx, draft: LockedDraft, planSnapshotId: number)
  : Promise<{ ok: true } | DraftRefusal> {
  const { rows } = await tx.query<{ id: number; shared: number }>(
    `SELECT s.id, (${planSnapshotSharedSql('s.id', '?')} OR ${planSnapshotInheritedSql('s', 'j.product_set_id')}) AS shared
       FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
      WHERE j.product_set_id = ? AND s.id = ? AND s.gym_id = ?`,
    [draft.id, draft.id, planSnapshotId, draft.gym_id]);
  if (!rows[0]) return { kind: 'not_found' };
  if (Number(rows[0].shared) === 1) {
    return { kind: 'conflict', error: 'plan_not_removable', message: 'To change your plan, please contact your gym.' };
  }
  await tx.query(
    `DELETE ump FROM user_membership_promotions ump JOIN promotions p ON p.id = ump.promotion_id
      WHERE ump.gym_id = ? AND ump.product_set_id = ? AND ump.recurrent_snapshot_id IS NULL
        AND p.applies_to = 'membership_plan'`, [draft.gym_id, draft.id]);
  await tx.query('DELETE FROM product_set_plan_snapshots WHERE product_set_id = ? AND plan_snapshot_id = ?',
    [draft.id, planSnapshotId]);
  await tx.query('DELETE FROM plan_snapshots WHERE id = ? AND gym_id = ?', [planSnapshotId, draft.gym_id]);
  const remaining = await primaryPlanSnapshotId(tx, draft.gym_id, draft.id);
  if (remaining == null) {
    await tx.query('UPDATE product_sets SET membership_plan_id = NULL WHERE id = ? AND gym_id = ?', [draft.id, draft.gym_id]);
  }
  await touch(tx, { ...draft, membership_plan_id: remaining == null ? null : draft.membership_plan_id });
  return { ok: true };
}
