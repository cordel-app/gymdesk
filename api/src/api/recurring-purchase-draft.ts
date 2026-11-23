// #1521 stage 2 — buying a **recurring** Product (Oscar's decision 1): the
// purchase is a new ProductSet version in `draft`, never an immediate charge
// and never a second billing mechanism.
//
// What it does, in one transaction:
//   1. creates the owner's next Draft (`createDraft`, the existing lifecycle:
//      one in-flight version per owner, two-hour expiry), carrying the Active
//      version's Membership Plan and start date so activating it does not drop
//      the plan the member holds;
//   2. clones the Active version's configuration onto it (`cloneConfiguration`,
//      the same copy an edit of a projected plan makes);
//   3. adds the Product as one more recurring line (`addService`'s rules, with
//      the duplicate guard lifted: a second weekly class is a second line);
//   4. freezes a direct discount on that line's own `unit_price`, and applies
//      the chosen product Promotions to the Draft.
//
// Nothing is activated or charged here. The version becomes the member's only
// through the existing Save & Pay (`POST /product-sets/:id/save-and-pay`) and
// the payment webhook, which is the one place a version is activated.

import { syncProductSnapshotsOfVersion } from './product-snapshot-sync';
import { refreshSetCart } from './purchases';
import { deleteProductApplication, lineApplications } from './product-promotion-writer';
import { ownRecurringLine, updateRecurringLine, type RecurringLinePatch } from './recurring-line-writer';
import type { Tx } from '../infra/db';
import { addService, lockDraft, isRefusal, type DraftRefusal } from './product-set-draft';
import { createDraft, type Actor } from './product-sets';
import { cloneConfiguration } from './product-set-bridge';
import { allocateItemSchedules } from './product-set-configuration';
import { applyPromotionToProductSet } from './membership-promotions';
import { discountedUnitPrice } from '../domain/productPurchasePricing';
import { staffProductDraftSql } from './editable-draft';

const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/**
 * #1865 — thrown (so the transaction rolls back and the Draft stays exactly as
 * it was) when the Product's billing frequency is not one the Draft's lines
 * already carry and the caller has not confirmed.
 */
export interface FrequencyItem {
  product_id: number; name: string; billing_frequency: string | null;
  description: string | null; image_url: string | null; image_thumbnail_url: string | null;
}

export class BillingFrequencyDiffers extends Error {
  constructor(
    readonly existing: string[], readonly incoming: string,
    /** #3059: the items behind the frequencies, so the dialog can name them. */
    readonly existingItems: FrequencyItem[] = [], readonly incomingItem: FrequencyItem | null = null,
  ) {
    super('billing_frequency_differs');
  }
}

export type RecurringDraftOutcome =
  | { kind: 'ok'; productSetId: number; lineId: number }
  | { kind: 'in_flight'; productSetId: number; status: string }
  | DraftRefusal;

export type EnsureDraftOutcome =
  | { kind: 'ok'; productSetId: number; created: boolean }
  | { kind: 'in_flight'; productSetId: number; status: string };

/**
 * #1537 — the owner's recurring-configuration Draft, created when there is none.
 *
 * Starting an edit (Edit, Add Product, a quantity, a removal) needs no explicit
 * "create draft" step: the first action asks for the Draft and every later one
 * gets the **same** row back, its two hours refreshed. Only a plain Draft is
 * reused — the Admin's plan-assignment Draft (`user_membership_id` set) and a
 * Pending Payment version stay what they were and answer `in_flight`, so a
 * member never has two versions in flight and an uncertain payment never gets
 * a second Draft. The Active version is cloned, never touched.
 *
 * #2858: for staff (`staff: true`) the owner's `⋮ → Edit` Draft of a running plan is reused too
 * (`editableDraftSql()`), so adding or changing a Product while a plan edit is open edits that same
 * Draft instead of answering `in_flight`. The Members App keeps reusing its plain Draft only.
 *
 * #2891: and so is a new-plan assignment Draft (`staffProductDraftSql()`): a recurring Product staff
 * add while a new Membership Plan is being assigned lands in that same Draft, beside the plan.
 */
export async function ensureRecurringDraft(tx: Tx, input: {
  gymId: string; memberId: number; actor: Actor; today: string; staff?: boolean;
}): Promise<EnsureDraftOutcome> {
  const { rows: activeRows } = await tx.query<any>(
    `SELECT id, membership_plan_id, starts_at, ends_at FROM product_sets
      WHERE gym_id = ? AND owner_member_id = ? AND status = 'active' FOR UPDATE`,
    [input.gymId, input.memberId]);
  const active = activeRows[0] ?? null;

  const created = await createDraft(tx, {
    gymId: input.gymId,
    ownerMemberId: input.memberId,
    membershipPlanId: active?.membership_plan_id != null ? Number(active.membership_plan_id) : null,
    startsAt: active ? dateOnly(active.starts_at) : input.today,
    actor: input.actor,
  });
  if (created.kind === 'in_flight') {
    if (created.status === 'in_cart') {
      const { rows } = await tx.query<any>(
        `SELECT ps.plan_assignment_id, ${staffProductDraftSql('ps')} AS editable
           FROM product_sets ps WHERE ps.id = ? AND ps.gym_id = ?`,
        [created.productSetId, input.gymId]);
      if (rows[0] && (rows[0].plan_assignment_id == null || (input.staff === true && Number(rows[0].editable) === 1))) {
        await refreshSetCart(tx, input.gymId, created.productSetId);
        return { kind: 'ok', productSetId: created.productSetId, created: false };
      }
    }
    return { kind: 'in_flight', productSetId: created.productSetId, status: created.status };
  }
  const draftId = created.productSet.id;
  if (active) {
    await tx.query('UPDATE product_sets SET ends_at = ? WHERE id = ?',
      [active.ends_at == null ? null : dateOnly(active.ends_at), draftId]);
    await cloneConfiguration(tx, input.gymId, Number(active.id), draftId);
  }
  return { kind: 'ok', productSetId: draftId, created: true };
}

export async function startRecurringPurchaseDraft(tx: Tx, input: {
  gymId: string;
  memberId: number;
  productId: number;
  promotionIds: readonly number[];
  directDiscountPercent: number | null;
  confirmFrequencyChange?: boolean;
  actor: Actor;
  today: string;
  /** #2609: the family member the line is for (resolved by the caller; `addService()` judges it again). */
  assignedMemberId?: number | null;
  /** #2858: a staff add also reuses the owner's `⋮ → Edit` Draft (`ensureRecurringDraft()`). */
  staff?: boolean;
  /** #3101: units of the new line (1 when absent); the caller has validated it. */
  quantity?: number;
}): Promise<RecurringDraftOutcome> {
  const ensured = await ensureRecurringDraft(tx, input);
  if (ensured.kind === 'in_flight') return ensured;
  const draftId = ensured.productSetId;

  const locked = await lockDraft(tx, input.gymId, draftId);
  if (isRefusal(locked)) return locked;

  if (!input.confirmFrequencyChange) {
    const { rows: freqs } = await tx.query<any>(
      // #2126 stage 3l: read before the new line is written, so every line it
      // reads is one an earlier Draft write already synced.
      `SELECT DISTINCT s.billing_frequency AS f FROM product_set_periodical_snapshots lnk
         JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
        WHERE s.gym_id = ? AND lnk.product_set_id = ? AND s.ends_at IS NULL AND s.billing_frequency IS NOT NULL`,
      [input.gymId, draftId]);
    const existing = freqs.map((r: any) => String(r.f));
    const { rows: prod } = await tx.query<any>(
      'SELECT billing_frequency FROM products WHERE id = ? AND gym_id = ?', [input.productId, input.gymId]);
    const incoming = prod[0]?.billing_frequency == null ? null : String(prod[0].billing_frequency);
    if (incoming && existing.length > 0 && !existing.includes(incoming)) {
      const itemSql = `p.id AS product_id, p.name, p.billing_frequency, p.description, p.image_url, p.image_thumbnail_url`;
      const shape = (r: any): FrequencyItem => ({
        product_id: Number(r.product_id), name: String(r.name), billing_frequency: r.billing_frequency ?? null,
        description: r.description ?? null, image_url: r.image_url ?? null, image_thumbnail_url: r.image_thumbnail_url ?? null,
      });
      const { rows: itemRows } = await tx.query<any>(
        `SELECT DISTINCT ${itemSql} FROM product_set_periodical_snapshots lnk
           JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
           JOIN products p ON p.id = s.product_id AND p.gym_id = s.gym_id
          WHERE s.gym_id = ? AND lnk.product_set_id = ? AND s.ends_at IS NULL AND s.billing_frequency IS NOT NULL
          ORDER BY p.name`,
        [input.gymId, draftId]);
      const { rows: inRows } = await tx.query<any>(
        `SELECT ${itemSql} FROM products p WHERE p.id = ? AND p.gym_id = ?`, [input.productId, input.gymId]);
      throw new BillingFrequencyDiffers(existing, incoming, itemRows.map(shape), inRows[0] ? shape(inRows[0]) : null);
    }
  }

  // #3167: a newly added Product starts today, never on a later plan start date.
  const startsAt = input.today;

  // Buying a recurring Product the member already has is a line of its own
  // (#1865 stage 2): its own price, discount, schedule and lifecycle, so
  // changing or removing one purchase never touches another.
  const added = await addService(tx, locked, { product_id: input.productId, quantity: input.quantity ?? 1, starts_at: startsAt, assigned_member_id: input.assignedMemberId ?? null }, { recurringByFrequency: true, allowRepeat: true });
  if ('kind' in added) return added;

  if (input.directDiscountPercent != null) {
    // #2126 stage 3r — the line's list price is read from its Product snapshot,
    // which `addService()` has just written; the discount goes onto both rows
    // through the line's one writer (stage 5c).
    const { rows } = await tx.query<any>(
      'SELECT unit_price FROM product_periodical_snapshots WHERE source_id = ? AND gym_id = ?',
      [added.id, input.gymId]);
    const list = Number(rows[0].unit_price);
    await updateRecurringLine(tx, input.gymId, added.id, {
      list_unit_price: list.toFixed(2),
      direct_discount_percent: input.directDiscountPercent.toFixed(2),
      unit_price: discountedUnitPrice(list, input.directDiscountPercent).toFixed(2),
    });
  }

  const refused = await applyPromotions(tx, input, draftId, added.id);
  if (refused) return refused;
  // The Promotions just applied are owned by the line: their snapshots follow it.
  await syncProductSnapshotsOfVersion(tx, input.gymId, draftId);
  return { kind: 'ok', productSetId: draftId, lineId: added.id };
}

/** Applies the chosen Product Promotions to the Draft; a refusal is returned, not thrown. */
async function applyPromotions(
  tx: Tx, input: { gymId: string; promotionIds: readonly number[]; actor: Actor }, draftId: number, lineId: number,
): Promise<DraftRefusal | null> {
  for (const promotionId of input.promotionIds) {
    try {
      await applyPromotionToProductSet(tx, input.gymId, input.actor.name, draftId, promotionId, { productTarget: true, lineId });
    } catch (err: any) {
      if (err?.status === 409) return { kind: 'conflict', error: err.message, message: err.message };
      if (err?.status) return { kind: 'invalid', message: err.message };
      throw err;
    }
  }
  return null;
}

/**
 * #2856 — edits one recurring line of the member's open Draft from the Products
 * list's `⋮ → Edit`: its quantity, its direct discount and the Product
 * Promotions it carries. Only a Draft is edited — a committed version never is
 * (#1325 stage 4) — and a line the Active version also links is copied for the
 * Draft first (`ownRecurringLine()`), so the Active version is untouched.
 *
 * The Promotion selection is **replace-all, keeping what stays**: an
 * application whose Promotion is still selected is left exactly as it is (so a
 * Promotion the line was already agreed with keeps its confirmed snapshot), a
 * deselected one is deleted outright (a Draft has charged nothing), and a newly
 * selected one goes through `applyPromotionToProductSet()`, which records the
 * reference only — the snapshot is taken by `confirmDraftPromotionSnapshots()`
 * at Save & Pay (#2833). The caller has already validated the selection against
 * the offers and priced the stack.
 */
export async function editRecurringPurchaseLine(tx: Tx, input: {
  gymId: string;
  memberId: number;
  lineId: number;
  quantity?: number;
  promotionIds?: readonly number[];
  /** `undefined` keeps the stored discount; `null` clears it. */
  directDiscountPercent?: number | null;
  actor: Actor;
}): Promise<{ kind: 'ok'; productSetId: number; lineId: number; productId: number } | { kind: 'no_draft' } | DraftRefusal> {
  const { rows: drafts } = await tx.query<any>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart'
      ORDER BY id DESC LIMIT 1`,
    [input.gymId, input.memberId]);
  if (!drafts[0]) return { kind: 'no_draft' };
  const locked = await lockDraft(tx, input.gymId, Number(drafts[0].id));
  if (isRefusal(locked)) return locked;
  const draftId = locked.id;

  const { rows: lines } = await tx.query<any>(
    `SELECT s.product_id, s.unit_price, s.list_price FROM product_set_periodical_snapshots lnk
       JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
      WHERE s.source_id = ? AND s.gym_id = ? AND lnk.product_set_id = ? AND s.ends_at IS NULL`,
    [input.lineId, input.gymId, draftId]);
  if (!lines[0]) return { kind: 'not_found' };
  const productId = Number(lines[0].product_id);

  if (input.quantity !== undefined && (!Number.isInteger(input.quantity) || input.quantity <= 0 || input.quantity > 999)) {
    return { kind: 'invalid', message: 'quantity must be a positive integer' };
  }

  // A line another Product Set links is copied for the Draft before it is written.
  const lineId = (await ownRecurringLine(tx, input.gymId, draftId, input.lineId)) ?? input.lineId;

  const patch: RecurringLinePatch = {};
  if (input.quantity !== undefined) patch.quantity = input.quantity;
  if (input.directDiscountPercent !== undefined) {
    const list = lines[0].list_price != null ? Number(lines[0].list_price) : Number(lines[0].unit_price);
    if (input.directDiscountPercent == null) {
      patch.unit_price = list.toFixed(2);
      patch.list_unit_price = null;
      patch.direct_discount_percent = null;
    } else {
      patch.list_unit_price = list.toFixed(2);
      patch.direct_discount_percent = input.directDiscountPercent.toFixed(2);
      patch.unit_price = discountedUnitPrice(list, input.directDiscountPercent).toFixed(2);
    }
  }
  await updateRecurringLine(tx, input.gymId, lineId, patch);

  if (input.promotionIds !== undefined) {
    const wanted = new Set(input.promotionIds.map(Number));
    // #3026 stage 3d-3c: the line's applications are its Product snapshot rows.
    const apps = await lineApplications(tx, input.gymId, draftId, lineId);
    const keep = new Set<number>();
    for (const app of apps) {
      if (app.status === 'applied' && wanted.has(Number(app.promotion_id)) && !keep.has(Number(app.promotion_id))) {
        keep.add(Number(app.promotion_id));
        continue;
      }
      // A Draft has charged nothing: a deselected application is deleted, its grant snapshots by the FK.
      await deleteProductApplication(tx, input.gymId, draftId, app.id);
    }
    const added = input.promotionIds.map(Number).filter((id) => !keep.has(id));
    const refused = await applyPromotions(tx, { gymId: input.gymId, promotionIds: added, actor: input.actor }, draftId, lineId);
    if (refused) return refused;
  }

  if (input.quantity !== undefined) await allocateItemSchedules(tx, input.gymId, draftId);
  await refreshSetCart(tx, input.gymId, draftId);
  await syncProductSnapshotsOfVersion(tx, input.gymId, draftId);
  return { kind: 'ok', productSetId: draftId, lineId, productId };
}
