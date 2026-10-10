// #1118 — the I/O half of a Promotion on a member's Product: which offers a
// catalogue read carries, what an applied one reads back as, and the write that
// freezes one onto a purchase.
//
// The split is the family's (`me-products.ts` over
// `domain/memberProductPurchase.ts`, #1121; `me-billing-forecast.ts` over its
// own, #1123): every rule lives in `domain/memberProductPromotion.ts` and this
// file is the queries and the one INSERT. There is deliberately nothing else in
// it — no second eligibility rule, no price arithmetic and no member named by a
// request (#1036: every statement here is constrained on `(gym_id, member_id)`
// or on a purchase already resolved from them).

import { db, type Tx } from '../infra/db';
import { isNewMemberStatus } from './new-member-eligibility';
import { type ProductBenefitCategory } from '../domain/productClassification';
import {
  type AppliedPromotion,
  type MemberProductPromotionOffer,
  PRODUCT_PROMOTION_TARGET,
  isOfferableBenefit,
  offerCategoryFor,
  promotionGrantTableFor,
  promotionApplicationSnapshot,
  shapeAppliedPromotion,
  shapePromotionOffer,
} from '../domain/memberProductPromotion';

/** A catalogue row as the offer query needs it: its category and its price. */
export interface OfferableProduct {
  id: number;
  type: string;
  billing_frequency: string | null;
  price_incl_tax: number | null;
}

/**
 * Every Promotion currently on offer for each of these Products, keyed by
 * Product id.
 *
 * The query is one `UNION ALL` over only the grant tables the Products in scope
 * actually need — a Product's offers live in the section it classifies into
 * (#550) and nowhere else, so a grant row left behind in another section by a
 * Product whose Billing Frequency later changed is not an offer for it.
 *
 * The window is the one every apply path already enforces
 * (`validatePromotionSelection()`): `lifecycle_status = 'active'` and
 * `starts_at <= now <= ends_at`, compared in SQL so no DATETIME crosses a
 * timezone conversion — the same comparison `promotionExpiryWhereSql()` makes
 * (#900), which is what keeps "offered to the member" and "accepted by the
 * server" one answer rather than two.
 *
 * `applies_to = 'product'` (#926) is read here for the first time: the column
 * has been configuration only since migration 204, and the thread's `Q4` is
 * what gives it a reader — a Promotion about a Membership Plan is not an offer
 * on a Product even if it happens to grant one.
 *
 * `only_applicable_for_new_members` (#927) is applied **after** the query, from
 * one evaluation of the Member's own status: it is the Member-level answer
 * (`isNewMemberStatus()`, no assignment excluded) because a purchase configures
 * no assignment to exclude, and it is read once rather than per offer.
 */
export async function loadPromotionOffers(
  gymId: string,
  memberId: number,
  products: readonly OfferableProduct[],
): Promise<Map<number, MemberProductPromotionOffer[]>> {
  const offers = new Map<number, MemberProductPromotionOffer[]>();
  if (products.length === 0) return offers;

  const byCategory = new Map<ProductBenefitCategory, OfferableProduct[]>();
  for (const product of products) {
    const category = offerCategoryFor(product);
    byCategory.set(category, [...(byCategory.get(category) ?? []), product]);
  }

  const arms: string[] = [];
  const params: unknown[] = [];
  for (const [category, items] of byCategory) {
    arms.push(`
      SELECT p.id AS promotion_id, p.name AS promotion_name, b.product_id,
             b.\`action\`, b.\`value\`, b.quantity,
             p.only_applicable_for_new_members, '${category}' AS category
        FROM ${promotionGrantTableFor(category)} b
        JOIN promotions p ON p.id = b.promotion_id AND p.gym_id = b.gym_id
       WHERE b.gym_id = ?
         AND b.product_id IN (${items.map(() => '?').join(',')})
         AND p.lifecycle_status = 'active'
         AND p.applies_to = ?
         AND p.starts_at <= UTC_TIMESTAMP()
         AND p.ends_at >= UTC_TIMESTAMP()`);
    params.push(gymId, ...items.map((i) => i.id), PRODUCT_PROMOTION_TARGET);
  }

  const { rows } = await db.query<any>(
    `${arms.join(' UNION ALL ')} ORDER BY promotion_name ASC, promotion_id ASC`,
    params,
  );
  if (rows.length === 0) return offers;

  const newMemberOffers = rows.some((row: any) => !!row.only_applicable_for_new_members);
  const isNew = newMemberOffers ? await isNewMemberStatus(db, gymId, memberId) : false;

  const priceById = new Map(products.map((p) => [Number(p.id), p.price_incl_tax]));
  for (const row of rows as any[]) {
    if (!isOfferableBenefit(row.action, row.value)) continue;
    if (row.only_applicable_for_new_members && !isNew) continue;
    const productId = Number(row.product_id);
    const offer = shapePromotionOffer(row, row.category as ProductBenefitCategory, priceById.get(productId) ?? null);
    // An offer is shown only while it prices the Product **lower than its own
    // price, and above nothing**. Three cases are excluded, and each for its
    // own reason:
    //
    //  * **no price at all** — there is no Final price to recalculate, and §5's
    //    whole action is that recalculation;
    //  * **priced to nothing** — this flow buys a Product by paying for it
    //    (§9, §16: "not considered successfully completed until payment has
    //    been successfully processed"), and there is no path here that grants
    //    one without a payment, so a `waive` grant would mean raising a €0
    //    charge at the provider. A Promotion that gives a Product away is an
    //    Assigned Plan's grant (#635 §16's snapshots), not something to put a
    //    Buy button under; granting a free Product from the Members App is a
    //    decision a ticket has to take;
    //  * **priced higher** — a `fixed_price` above the Product's own price is a
    //    configuration the vocabulary permits and a *promotion* it is not.
    //    §4/§5 describe something the member applies to pay less, so offering
    //    it would present a price increase as a benefit on the one screen where
    //    that is never acceptable. It is the same judgment as the `no_benefit`
    //    filter above (an offer that changes nothing), one step further.
    //
    // The last of the three is the bound `chk_mprodp_amounts` states. That
    // CHECK is deliberately wider than this filter (migration 229's header
    // says why), so this loader — the only thing that produces an application
    // — is where the narrow rule lives.
    const regular = offer.regular_price_incl_tax;
    const final = offer.final_price_incl_tax;
    if (regular == null || final == null) continue;
    if (!(final > 0) || !(final < regular)) continue;
    offers.set(productId, [...(offers.get(productId) ?? []), offer]);
  }
  return offers;
}

/**
 * The one offer a member named, re-read and re-priced at the moment they buy.
 *
 * It is deliberately the **same** loader rather than a narrower query: the
 * Promotion may have expired, been switched off or been re-configured between
 * the quote and the Buy, and re-asking the one rule is what stops the purchase
 * being charged a price the catalogue no longer offers. `null` means "not
 * applicable any more", which the route answers as a refusal rather than by
 * quietly charging the regular price.
 */
export async function resolvePurchasePromotion(
  gymId: string,
  memberId: number,
  product: OfferableProduct,
  promotionId: number,
): Promise<MemberProductPromotionOffer | null> {
  const offers = await loadPromotionOffers(gymId, memberId, [product]);
  return (offers.get(Number(product.id)) ?? []).find((o) => o.promotion_id === promotionId) ?? null;
}

/**
 * Freezes the applied Promotion onto the purchase, in the purchase's own
 * transaction.
 *
 * Written beside the `member_products_oneoff_snapshot` row rather than after it for #1121
 * stage 2's reason: a purchase and what it was priced under are one record, so
 * a failure that left the purchase without its Promotion would charge a
 * discounted amount with nothing on file explaining it (§15).
 */
export async function writePurchasePromotion(
  tx: Tx,
  gymId: string,
  memberProductId: number,
  offer: MemberProductPromotionOffer,
): Promise<void> {
  const snapshot = promotionApplicationSnapshot(offer);
  if (!snapshot) return;
  await tx.query(
    `INSERT INTO member_products_oneoff_promotion_snapshot
       (gym_id, member_product_id, promotion_id, promotion_name,
        benefit_action, benefit_value, duration_cycles, regular_amount, final_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      gymId, memberProductId, offer.promotion_id, snapshot.promotion_name,
      snapshot.benefit_action,
      snapshot.benefit_value == null ? null : snapshot.benefit_value.toFixed(2),
      snapshot.duration_cycles,
      snapshot.regular_amount.toFixed(2), snapshot.final_amount.toFixed(2),
    ],
  );
}

/** The columns every read of an application projects. */
const APPLICATION_COLUMNS = `
  mpp.id, mpp.member_product_id, mpp.promotion_id, mpp.promotion_name,
  mpp.benefit_action, mpp.benefit_value, mpp.duration_cycles,
  mpp.regular_amount, mpp.final_amount, mpp.applied_at`;

/**
 * The Promotion applied to each of these purchases, keyed by purchase id.
 *
 * Read from the snapshot and **never** from a live join onto `promotions` or
 * its grant tables (§13: "the Admin should not dynamically resolve the current
 * Promotion configuration to determine what was applied historically") — which
 * is #635 §16's rule, and the reason the table carries the name and both
 * amounts rather than only the ids.
 */
export async function loadAppliedPromotions(
  gymId: string,
  memberProductIds: readonly number[],
): Promise<Map<number, AppliedPromotion>> {
  const byPurchase = new Map<number, AppliedPromotion>();
  const ids = Array.from(new Set(memberProductIds.map(Number))).filter((id) => Number.isFinite(id));
  if (ids.length === 0) return byPurchase;

  const { rows } = await db.query<any>(
    `SELECT ${APPLICATION_COLUMNS}
       FROM member_products_oneoff_promotion_snapshot mpp
      WHERE mpp.gym_id = ? AND mpp.member_product_id IN (${ids.map(() => '?').join(',')})`,
    [gymId, ...ids],
  );
  for (const row of rows as any[]) {
    byPurchase.set(Number(row.member_product_id), shapeAppliedPromotion(row));
  }
  return byPurchase;
}

/** One purchase as the Admin and the member both read it back (§12, §13). */
export interface MemberPurchasedProduct {
  id: number;
  product_id: number;
  status: string;
  product_name: string;
  product_type: string;
  billing_frequency: string | null;
  units: number | null;
  /** What the member was charged, VAT included — the *Final price* of §13. */
  amount: number;
  currency: string;
  purchased_at: string | null;
  created_at: string | null;
  created_by_name: string | null;
  created_by_type: string | null;
  /** The Product's regular price: the application's own, else the charge itself. */
  regular_amount: number;
  promotion: AppliedPromotion | null;
}

/**
 * Every Product this member has bought, newest first, each with the Promotion
 * it was bought under.
 *
 * `cancelled` rows are included: §12 asks the Admin to understand "exactly what
 * the member purchased and under which pricing conditions", and a checkout that
 * never completed is part of that — the member's own catalogue is where a
 * cancelled attempt is silent (it simply reads *available* again).
 *
 * Every column of the row is the purchase's **snapshot** (migration 228), so
 * nothing here joins `products` either: a Product renamed or repriced since
 * must not move what a past purchase says it was.
 */
export async function loadMemberPurchases(
  gymId: string,
  memberId: number,
): Promise<MemberPurchasedProduct[]> {
  const { rows } = await db.query<any>(
    `SELECT mp.id, mp.product_id, mp.status, mp.product_name, mp.product_type,
            mp.billing_frequency, mp.units, mp.amount, mp.currency,
            mp.purchased_at, mp.created_at, mp.created_by_name, mp.created_by_type
       FROM member_products_oneoff_snapshot mp
      WHERE mp.gym_id = ? AND mp.member_id = ?
      ORDER BY mp.created_at DESC, mp.id DESC`,
    [gymId, memberId],
  );
  const promotions = await loadAppliedPromotions(gymId, rows.map((r: any) => Number(r.id)));
  return rows.map((row: any) => {
    const promotion = promotions.get(Number(row.id)) ?? null;
    const amount = Number(row.amount);
    return {
      id: Number(row.id),
      product_id: Number(row.product_id),
      status: row.status,
      product_name: row.product_name,
      product_type: row.product_type,
      billing_frequency: row.billing_frequency ?? null,
      units: row.units == null ? null : Number(row.units),
      amount,
      currency: row.currency ?? 'EUR',
      purchased_at: row.purchased_at ?? null,
      created_at: row.created_at ?? null,
      created_by_name: row.created_by_name ?? null,
      created_by_type: row.created_by_type ?? null,
      // With no Promotion the two figures are the same number: the purchase was
      // charged at the Product's own price, and §13's *Price* line still has
      // something honest to read.
      regular_amount: promotion ? promotion.regular_amount : amount,
      promotion,
    };
  });
}
