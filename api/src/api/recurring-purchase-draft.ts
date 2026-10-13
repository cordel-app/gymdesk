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

import type { Tx } from '../infra/db';
import { addService, lockDraft, isRefusal, type DraftRefusal } from './product-set-draft';
import { createDraft, type Actor } from './product-sets';
import { cloneConfiguration } from './product-set-bridge';
import { allocateItemSchedules } from './product-set-configuration';
import { applyPromotionToProductSet } from './membership-promotions';
import { discountedUnitPrice } from '../domain/productPurchasePricing';

const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

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
 */
export async function ensureRecurringDraft(tx: Tx, input: {
  gymId: string; memberId: number; actor: Actor; today: string;
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
    if (created.status === 'draft') {
      const { rows } = await tx.query<any>(
        'SELECT user_membership_id FROM product_sets WHERE id = ? AND gym_id = ?',
        [created.productSetId, input.gymId]);
      if (rows[0] && rows[0].user_membership_id == null) {
        await tx.query(
          'UPDATE product_sets SET last_activity_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ?',
          [created.productSetId, input.gymId]);
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
  actor: Actor;
  today: string;
}): Promise<RecurringDraftOutcome> {
  const ensured = await ensureRecurringDraft(tx, input);
  if (ensured.kind === 'in_flight') return ensured;
  const draftId = ensured.productSetId;

  const locked = await lockDraft(tx, input.gymId, draftId);
  if (isRefusal(locked)) return locked;

  // A line never starts before the version does, and a purchase made today
  // starts today.
  const startsAt = input.today > locked.starts_at ? input.today : locked.starts_at;

  // Buying a recurring Product the member already has (a second class per
  // week) raises the quantity of its one open line: the schema allows one open
  // line per Product and version (`ums_one_open_per_set_item`), and two units
  // of one line is what "twice" means. It is only a merge when both are the
  // same agreement — the same list price and the same direct discount —
  // because one line carries one price; otherwise it is refused and says why,
  // never silently repriced.
  const { rows: openLines } = await tx.query<any>(
    `SELECT s.id, s.quantity, s.unit_price, s.list_unit_price, s.direct_discount_percent, p.amount AS catalogue_amount
       FROM member_products_recurrent_snapshot s JOIN products p ON p.id = s.product_id AND p.gym_id = s.gym_id
      WHERE s.gym_id = ? AND s.product_set_id = ? AND s.product_id = ? AND s.ends_at IS NULL FOR UPDATE`,
    [input.gymId, draftId, input.productId]);
  if (openLines[0]) {
    const line = openLines[0];
    const linePct = line.direct_discount_percent == null ? null : Number(line.direct_discount_percent);
    const listPrice = Number(line.list_unit_price ?? line.unit_price);
    const sameAgreement = (linePct ?? null) === (input.directDiscountPercent ?? null)
      && Math.abs(listPrice - Number(line.catalogue_amount ?? 0)) < 0.005;
    if (!sameAgreement) {
      return {
        kind: 'conflict',
        error: 'recurring_line_conflict',
        message: 'The member already has this product at a different price or discount; it cannot be added to the same line',
      };
    }
    await tx.query('UPDATE member_products_recurrent_snapshot SET quantity = quantity + 1 WHERE id = ? AND gym_id = ?',
      [line.id, input.gymId]);
    await allocateItemSchedules(tx, input.gymId, draftId);
    await applyPromotions(tx, input, draftId);
    return { kind: 'ok', productSetId: draftId, lineId: Number(line.id) };
  }

  const added = await addService(tx, locked, { product_id: input.productId, quantity: 1, starts_at: startsAt });
  if ('kind' in added) return added;

  if (input.directDiscountPercent != null) {
    const { rows } = await tx.query<any>(
      'SELECT unit_price FROM member_products_recurrent_snapshot WHERE id = ? AND gym_id = ?',
      [added.id, input.gymId]);
    const list = Number(rows[0].unit_price);
    await tx.query(
      `UPDATE member_products_recurrent_snapshot
          SET list_unit_price = ?, direct_discount_percent = ?, unit_price = ?
        WHERE id = ? AND gym_id = ?`,
      [list.toFixed(2), input.directDiscountPercent.toFixed(2),
        discountedUnitPrice(list, input.directDiscountPercent).toFixed(2), added.id, input.gymId]);
  }

  const refused = await applyPromotions(tx, input, draftId);
  if (refused) return refused;
  return { kind: 'ok', productSetId: draftId, lineId: added.id };
}

/** Applies the chosen Product Promotions to the Draft; a refusal is returned, not thrown. */
async function applyPromotions(
  tx: Tx, input: { gymId: string; promotionIds: readonly number[]; actor: Actor }, draftId: number,
): Promise<DraftRefusal | null> {
  for (const promotionId of input.promotionIds) {
    try {
      await applyPromotionToProductSet(tx, input.gymId, input.actor.name, draftId, promotionId, { productTarget: true });
    } catch (err: any) {
      if (err?.status === 409) return { kind: 'conflict', error: err.message, message: err.message };
      if (err?.status) return { kind: 'invalid', message: err.message };
      throw err;
    }
  }
  return null;
}
