import { DRAFT_TTL_MINUTES } from '../domain/productSet';
import { assignedMemberSql } from '../domain/productAssignee';
import { MEMBER_PURCHASE_SNAPSHOTS_SQL, memberPurchaseSnapshotParams } from './purchase-snapshots';
import { toItemOrigin, type ItemOrigin } from '../domain/itemOrigin';
import { DateTime } from 'luxon';
import { purchaseValidityState } from '../domain/productValidity';
import { resolveTimeZone } from '../domain/homeDashboard';
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

import { db } from '../infra/db';
import { isNewMemberStatus } from './new-member-eligibility';
import { type ProductBenefitCategory } from '../domain/productClassification';
import { toProductBenefit } from '../domain/productBenefitActions';
import {
  type AppliedPromotion,
  type MemberProductPromotionOffer,
  PRODUCT_PROMOTION_TARGET,
  isOfferableBenefit,
  offerCategoryFor,
  promotionGrantTableFor,
  promotionalPrice,
  promotionDurationCycles,
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
  return (await loadPromotionOffersDetailed(gymId, memberId, products)).offers;
}

/** A Promotion that would be offered but for the new-members-only rule (#1655). */
export interface SkippedPromotion {
  promotion_id: number;
  promotion_name: string;
  reason: 'new_members_only';
}

/**
 * `loadPromotionOffers()` plus, per Product, the Promotions that passed every
 * other check and were hidden only because the Member is not a New Member
 * (#927). The staff selector reports them so "No promotions available" can say
 * why; they are never offers and can never be applied.
 */
export async function loadPromotionOffersDetailed(
  gymId: string,
  memberId: number,
  products: readonly OfferableProduct[],
): Promise<{ offers: Map<number, MemberProductPromotionOffer[]>; skipped: Map<number, SkippedPromotion[]> }> {
  const offers = new Map<number, MemberProductPromotionOffer[]>();
  const skipped = new Map<number, SkippedPromotion[]>();
  if (products.length === 0) return { offers, skipped };

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
             p.only_applicable_for_new_members, p.stackable, '${category}' AS category
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
  if (rows.length === 0) return { offers, skipped };

  const newMemberOffers = rows.some((row: any) => !!row.only_applicable_for_new_members);
  const isNew = newMemberOffers ? await isNewMemberStatus(db, gymId, memberId) : false;

  const priceById = new Map(products.map((p) => [Number(p.id), p.price_incl_tax]));
  for (const row of rows as any[]) {
    if (!isOfferableBenefit(row.action, row.value)) continue;
    const productId = Number(row.product_id);
    const hiddenForNotNew = !!row.only_applicable_for_new_members && !isNew;
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
    if (hiddenForNotNew) {
      skipped.set(productId, [...(skipped.get(productId) ?? []), {
        promotion_id: offer.promotion_id, promotion_name: offer.promotion_name, reason: 'new_members_only',
      }]);
      continue;
    }
    offers.set(productId, [...(offers.get(productId) ?? []), offer]);
  }
  return { offers, skipped };
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
 * #2126 stage 3g — the Promotions frozen onto each purchase, read from
 * `product_promotion_snapshots` (kept equal to `member_products_oneoff_promotion_snapshot`
 * by stage 2's dual-write, `syncProductSnapshotForPurchase()`), through the purchase's
 * own Product snapshot (a Sessions package or any other one-off). `id` is still the
 * legacy application id (`source_purchase_promotion_id`) and `member_product_id` the
 * purchase id (the parent snapshot's `source_id`), so the shapes and the order (by
 * application id) are unchanged.
 */
const APPLICATION_COLUMNS = `
  pp.source_purchase_promotion_id AS id, par.source_id AS member_product_id,
  pp.promotion_id, pp.promotion_name, pp.benefit_action, pp.benefit_value,
  pp.duration_cycles, pp.regular_amount, pp.final_amount, pp.applied_at`;

function purchaseApplicationsSql(placeholders: string): string {
  const arm = (parent: string, parentCol: string) => `
    SELECT ${APPLICATION_COLUMNS}
      FROM product_promotion_snapshots pp
      JOIN ${parent} par ON par.id = pp.${parentCol} AND par.gym_id = pp.gym_id
     WHERE pp.gym_id = ? AND pp.source_purchase_promotion_id IS NOT NULL
       AND par.source_id IN (${placeholders})`;
  return `SELECT * FROM (
    ${arm('product_session_snapshots', 'product_session_snapshot_id')}
    UNION ALL
    ${arm('product_oneoff_snapshots', 'product_oneoff_snapshot_id')}
  ) mpp ORDER BY mpp.id ASC`;
}

/**
 * The Promotion applied to each of these purchases, keyed by purchase id.
 *
 * Read from the snapshot and **never** from a live join onto `promotions` or
 * its grant tables (§13: "the Admin should not dynamically resolve the current
 * Promotion configuration to determine what was applied historically") — which
 * is #635 §16's rule, and the reason the table carries the name and both
 * amounts rather than only the ids.
 */
/**
 * #1521 — every Promotion applied to each purchase, in the order they were
 * applied (each one's `regular_amount` is the running price it was applied to).
 */
export async function loadAppliedPromotionLists(
  gymId: string,
  memberProductIds: readonly number[],
): Promise<Map<number, AppliedPromotion[]>> {
  const byPurchase = new Map<number, AppliedPromotion[]>();
  const ids = Array.from(new Set(memberProductIds.map(Number))).filter((id) => Number.isFinite(id));
  if (ids.length === 0) return byPurchase;
  const { rows } = await db.query<any>(
    purchaseApplicationsSql(ids.map(() => '?').join(',')),
    [gymId, ...ids, gymId, ...ids],
  );
  for (const row of rows as any[]) {
    const key = Number(row.member_product_id);
    byPurchase.set(key, [...(byPurchase.get(key) ?? []), shapeAppliedPromotion(row)]);
  }
  return byPurchase;
}

export async function loadAppliedPromotions(
  gymId: string,
  memberProductIds: readonly number[],
): Promise<Map<number, AppliedPromotion>> {
  const byPurchase = new Map<number, AppliedPromotion>();
  const ids = Array.from(new Set(memberProductIds.map(Number))).filter((id) => Number.isFinite(id));
  if (ids.length === 0) return byPurchase;

  const { rows } = await db.query<any>(
    purchaseApplicationsSql(ids.map(() => '?').join(',')),
    [gymId, ...ids, gymId, ...ids],
  );
  for (const row of rows as any[]) {
    // A purchase may now carry several (#1521); this older single-valued read
    // reports the first one applied, as it always did when there was only one.
    if (!byPurchase.has(Number(row.member_product_id))) {
      byPurchase.set(Number(row.member_product_id), shapeAppliedPromotion(row));
    }
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
  /** #1693 — last valid day (inclusive), the day a cancellation was recorded, and the derived state. */
  valid_until?: string | null;
  cancelled_on?: string | null;
  validity_state?: string | null;
  created_at: string | null;
  /** The plain-text actor snapshot (#1182): the member, or `Staff (impersonating …)`. */
  created_by: string | null;
  /** #1883 — where it came from; null reads as Unknown. */
  origin: ItemOrigin | null;
  /** The Product's regular price: the application's own, else the charge itself. */
  regular_amount: number;
  /** The first Promotion applied (kept for readers written before stacking). */
  promotion: AppliedPromotion | null;
  /** #1521 — every Promotion applied, in order; empty when none. */
  promotions: AppliedPromotion[];
  /** #1521 — the VAT-inclusive list price the purchase started from, when stored. */
  list_price: number | null;
  /** #1521 — an Admin's direct discount: percentage and resulting amount. */
  direct_discount_percent: number | null;
  direct_discount_amount: number | null;
  /**
   * #1521 — the VAT rate the purchase was charged under, as the snapshot froze
   * it (a percentage; `null` when the gym had no rate configured then).
   */
  tax_rate_percent: number | null;
  /**
   * #1521 — the purchase's own payment request status (`pending`, `completed`,
   * `failed`, `expired`), the source the Members list's Payment Status reads
   * (#1235); `null` when the purchase has no payment request.
   */
  payment_status: string | null;
  /**
   * #1521 — the Billing Event that this purchase's payment settles, through its
   * own `payment_request_id` (never the member's latest event); `null` when
   * none exists.
   */
  billing_event_id: number | null;
  /**
   * #1661 — where the row comes from: a one-time purchase snapshot, or a
   * recurring Product line of the member's Active / Pending Payment ProductSet.
   * A recurring row's `id` is the negative of the line id so it can never
   * collide with a purchase id in a list keyed on `id`.
   */
  source?: 'one_off' | 'recurring';
  /** #1882 — removed in the member's open Draft; still Active until Save & Pay. */
  pending_termination?: boolean;
  /**
   * #2609 — the family member the Product is for: the stored assignee, else the
   * purchaser / Product Set owner (a row written before the column existed, or a
   * shared Product, which the purchaser holds for the family).
   */
  assigned_member_id: number | null;
  assigned_member_name: string | null;
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
 * Every column of the row is the purchase's **snapshot** (migration 228; read
 * from the Product snapshot tables since #2126 stage 3d, its payment request
 * reached through the Billing Event junction since stage 5a), so nothing here joins `products` either: a Product renamed or repriced since
 * must not move what a past purchase says it was.
 */
export async function loadMemberPurchases(
  gymId: string,
  memberId: number,
): Promise<MemberPurchasedProduct[]> {
  const { rows } = await db.query<any>(
    `SELECT mp.id, mp.product_id, mp.status, mp.product_name, mp.product_type,
            mp.billing_frequency, mp.units, mp.amount, mp.currency,
            mp.purchased_at, mp.created_at, mp.created_by, mp.origin,
            DATE_FORMAT(mp.valid_until, '%Y-%m-%d') AS valid_until,
            DATE_FORMAT(mp.cancelled_on, '%Y-%m-%d') AS cancelled_on,
            mp.tax_rate_percent, mp.list_price,
            mp.direct_discount_percent, mp.direct_discount_amount,
            pr.status AS payment_status, pr.billing_event_id AS billing_event_id,
            ${assignedMemberSql('mp', 'mp.member_id')} AS assigned_member_id,
            (SELECT am.name FROM members am WHERE am.id = ${assignedMemberSql('mp', 'mp.member_id')}) AS assigned_member_name
       FROM ${MEMBER_PURCHASE_SNAPSHOTS_SQL} mp
       LEFT JOIN payment_requests pr
              ON pr.id = mp.payment_request_id AND pr.gym_id = mp.gym_id
      ORDER BY mp.created_at DESC, mp.id DESC`,
    memberPurchaseSnapshotParams(gymId, memberId),
  );
  const { rows: gymRows } = await db.query<any>('SELECT time_zone FROM gyms WHERE id = ?', [gymId]);
  const today = DateTime.now().setZone(resolveTimeZone(gymRows[0]?.time_zone)).toISODate()!;
  const promotions = await loadAppliedPromotionLists(gymId, rows.map((r: any) => Number(r.id)));
  const oneOff: MemberPurchasedProduct[] = rows.map((row: any) => {
    const applied = promotions.get(Number(row.id)) ?? [];
    const promotion = applied[0] ?? null;
    const amount = Number(row.amount);
    const listPrice = row.list_price == null ? null : Number(row.list_price);
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
      valid_until: row.valid_until ?? null,
      cancelled_on: row.cancelled_on ?? null,
      validity_state: purchaseValidityState(row, today),
      created_at: row.created_at ?? null,
      created_by: row.created_by ?? null,
      origin: toItemOrigin(row.origin),
      // With no Promotion the two figures are the same number: the purchase was
      // charged at the Product's own price, and §13's *Price* line still has
      // something honest to read.
      // The price before any Promotion or discount: the stored list price,
      // else (purchases written before #1521) the first Promotion's own
      // starting figure, else what was charged.
      regular_amount: listPrice ?? (promotion ? promotion.regular_amount : amount),
      promotion,
      promotions: applied,
      list_price: listPrice,
      direct_discount_percent: row.direct_discount_percent == null ? null : Number(row.direct_discount_percent),
      direct_discount_amount: row.direct_discount_amount == null ? null : Number(row.direct_discount_amount),
      tax_rate_percent: row.tax_rate_percent == null ? null : Number(row.tax_rate_percent),
      payment_status: row.payment_status ?? null,
      billing_event_id: row.billing_event_id == null ? null : Number(row.billing_event_id),
      assigned_member_id: row.assigned_member_id == null ? null : Number(row.assigned_member_id),
      assigned_member_name: row.assigned_member_name ?? null,
    };
  });
  const recurring = await loadRecurringPurchases(gymId, memberId);
  return [...oneOff, ...recurring].sort(
    (a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
  );
}


/**
 * #2576 — the Promotions applied to recurring lines, keyed by line id, priced
 * from each application's own frozen grant (`user_membership_promotion_*_snapshot`),
 * never the live Promotion. Each step's `regular_amount` is the running price it
 * was applied to, as for a one-time purchase; the direct discount comes last.
 */
export async function loadRecurringLinePromotions(
  gymId: string,
  lines: readonly { id: number; productId: number; listUnit: number; quantity: number; pct: number | null }[],
): Promise<Map<number, { promotions: AppliedPromotion[]; final: number | null }>> {
  const out = new Map<number, { promotions: AppliedPromotion[]; final: number | null }>();
  if (lines.length === 0) return out;
  const ids = lines.map((l) => l.id);
  const { rows } = await db.query<any>(
    `SELECT ump.id, ump.promotion_id, ump.recurrent_snapshot_id, ump.applied_at, ump.snapshot
       FROM user_membership_promotions ump
      WHERE ump.gym_id = ? AND ump.status = 'applied'
        AND ump.recurrent_snapshot_id IN (${ids.map(() => '?').join(',')})
      ORDER BY ump.id ASC`,
    [gymId, ...ids],
  );
  if (rows.length === 0) return out;
  const appIds = rows.map((r: any) => Number(r.id));
  const marks = appIds.map(() => '?').join(',');
  const grants = new Map<string, { action: unknown; value: unknown; quantity: unknown; category: ProductBenefitCategory }>();
  for (const category of ['session', 'oneoff', 'periodical'] as const) {
    const { rows: g } = await db.query<any>(
      `SELECT user_membership_promotion_id AS app_id, product_id, \`action\`, \`value\`, quantity
         FROM user_membership_promotion_${category}_snapshot
        WHERE gym_id = ? AND user_membership_promotion_id IN (${marks})`,
      [gymId, ...appIds],
    );
    for (const r of g as any[]) grants.set(`${r.app_id}:${r.product_id}`, { ...r, category });
  }
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const running = new Map<number, number>();
  for (const row of rows as any[]) {
    const lineId = Number(row.recurrent_snapshot_id);
    const line = lineById.get(lineId)!;
    const grant = grants.get(`${row.id}:${line.productId}`);
    if (!grant) continue;
    const snap = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
    const benefit = toProductBenefit('promotion', grant.action, grant.value);
    const before = running.get(lineId) ?? line.listUnit;
    const after = promotionalPrice(before, benefit);
    if (after == null) continue;
    running.set(lineId, after);
    const entry = out.get(lineId) ?? { promotions: [], final: null };
    entry.promotions.push(shapeAppliedPromotion({
      id: row.id, promotion_id: row.promotion_id, promotion_name: snap?.name ?? `Promotion #${row.promotion_id}`,
      benefit_action: benefit.action, benefit_value: benefit.value,
      duration_cycles: promotionDurationCycles(grant.category, grant.quantity),
      regular_amount: Math.round(before * line.quantity * 100) / 100,
      final_amount: Math.round(after * line.quantity * 100) / 100,
      applied_at: row.applied_at ?? null,
    }));
    out.set(lineId, entry);
  }
  for (const [lineId, entry] of out) {
    const line = lineById.get(lineId)!;
    const afterPromos = running.get(lineId) ?? line.listUnit;
    const net = line.pct != null ? afterPromos * (1 - line.pct / 100) : afterPromos;
    entry.final = Math.round(net * line.quantity * 100) / 100;
  }
  return out;
}

/**
 * #1661 — the recurring Products of the member's Active (or Pending Payment)
 * ProductSet, in the purchase shape. A recurring purchase writes no
 * `member_products_oneoff_snapshot` row: it is a line of a ProductSet version,
 * whose own frozen columns (`unit_price`, `list_unit_price`,
 * `direct_discount_percent`) are what is read — never the live catalogue.
 * Nothing is written; this is a projection.
 *
 * #2126 stage 3g: the lines are read from `product_periodical_snapshots` (kept
 * equal to each version's lines by stage 2's dual-write), with the legacy line
 * id (`source_id`) still reported as each line's `id`.
 */
async function loadRecurringPurchases(
  gymId: string,
  memberId: number,
): Promise<MemberPurchasedProduct[]> {
  const { rows } = await db.query<any>(
    `SELECT s.source_id AS id, s.product_id, s.quantity, s.product_name AS item_name,
            s.product_type AS item_type, s.unit_price, s.list_price AS list_unit_price,
            s.direct_discount_percent, s.billing_frequency AS item_billing_frequency,
            s.currency, s.starts_at, s.created_at, s.origin, ps.status AS set_status,
            COALESCE(s.line_ref, s.source_id) AS line_ref,
            ps.created_by AS set_created_by,
            pr.status AS payment_status, pr.billing_event_id AS billing_event_id,
            ${assignedMemberSql('s', 'ps.owner_member_id')} AS assigned_member_id,
            (SELECT am.name FROM members am WHERE am.id = ${assignedMemberSql('s', 'ps.owner_member_id')}) AS assigned_member_name
       FROM product_sets ps
       JOIN product_set_periodical_snapshots lnk ON lnk.product_set_id = ps.id
       JOIN product_periodical_snapshots s
         ON s.id = lnk.product_periodical_snapshot_id AND s.gym_id = ps.gym_id AND s.source_id IS NOT NULL
       LEFT JOIN payment_requests pr
              ON pr.id = ps.payment_request_id AND pr.gym_id = ps.gym_id
      WHERE ps.gym_id = ? AND ps.owner_member_id = ?
        AND ps.status IN ('active', 'pending_payment')
        AND (s.ends_at IS NULL OR s.ends_at >= CURDATE())
      ORDER BY s.created_at DESC, s.source_id DESC`,
    [gymId, memberId],
  );
  // #1882 — a line of the Active version that the member's open Draft no longer
  // carries (matched by `line_ref`, which a clone keeps) is pending termination:
  // the Draft only registers the removal, the Active version is untouched.
  // #2479 — the open (unexpired) Draft's own lines are listed too: a line the
  // Draft added shows as a Draft row, and a line it changed shows the Draft's
  // frozen figures, so the list reflects the Product Set being edited.
  const { rows: draftRows } = await db.query<any>(
    `SELECT s.source_id AS id, s.product_id, s.quantity, s.product_name AS item_name,
            s.product_type AS item_type, s.unit_price, s.list_price AS list_unit_price,
            s.direct_discount_percent, s.billing_frequency AS item_billing_frequency,
            s.currency, s.starts_at, s.created_at, s.origin,
            COALESCE(s.line_ref, s.source_id) AS line_ref, ps.created_by AS set_created_by,
            ${assignedMemberSql('s', 'ps.owner_member_id')} AS assigned_member_id,
            (SELECT am.name FROM members am WHERE am.id = ${assignedMemberSql('s', 'ps.owner_member_id')}) AS assigned_member_name
       FROM product_sets ps
       JOIN product_set_periodical_snapshots lnk ON lnk.product_set_id = ps.id
       JOIN product_periodical_snapshots s
         ON s.id = lnk.product_periodical_snapshot_id AND s.gym_id = ps.gym_id AND s.source_id IS NOT NULL
      WHERE ps.gym_id = ? AND ps.owner_member_id = ? AND ps.status = 'draft'
        AND ps.last_activity_at >= UTC_TIMESTAMP() - INTERVAL ${DRAFT_TTL_MINUTES} MINUTE
        AND (s.ends_at IS NULL OR s.ends_at >= CURDATE())
      ORDER BY s.created_at DESC, s.source_id DESC`,
    [gymId, memberId],
  );
  const hasDraft = draftRows.length > 0 || (await db.query<any>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'draft' LIMIT 1`,
    [gymId, memberId],
  )).rows.length > 0;
  const draftByRef = new Map<number, any>(draftRows.map((r: any) => [Number(r.line_ref), r]));
  const activeRefs = new Set(rows.map((r: any) => Number(r.line_ref)));
  const draftLineRefs = new Set(draftByRef.keys());
  const lineInputs = [...rows, ...draftRows].map((r: any) => {
    const quantity = Number(r.quantity) || 1;
    const unit = Number(r.unit_price);
    const listUnit = r.list_unit_price == null ? unit : Number(r.list_unit_price);
    return {
      id: Number(r.id), productId: Number(r.product_id), listUnit, quantity,
      pct: r.direct_discount_percent == null ? null : Number(r.direct_discount_percent),
    };
  });
  const linePromos = await loadRecurringLinePromotions(gymId, lineInputs);
  const figures = (row: any) => {
    const quantity = Number(row.quantity) || 1;
    const unit = Number(row.unit_price);
    const amount = Math.round(unit * quantity * 100) / 100;
    // #2479 — `list_unit_price` is only stored beside a direct discount; without
    // one, `unit_price` *is* the list price (the same rule `lineInputs` prices the
    // line's Promotions from), so the regular price is never the promoted amount.
    const listUnit = row.list_unit_price == null ? unit : Number(row.list_unit_price);
    const listPrice = Math.round(listUnit * quantity * 100) / 100;
    const pct = row.direct_discount_percent == null ? null : Number(row.direct_discount_percent);
    return { amount, listPrice, pct };
  };
  const draftOnly: MemberPurchasedProduct[] = draftRows
    .filter((r: any) => !activeRefs.has(Number(r.line_ref)))
    .map((row: any) => {
      const { amount: baseAmount, listPrice, pct } = figures(row);
      const lp = linePromos.get(Number(row.id));
      const amount = lp?.final ?? baseAmount;
      return {
        id: -Number(row.id),
        product_id: Number(row.product_id),
        status: 'draft' as const,
        product_name: row.item_name,
        product_type: row.item_type,
        billing_frequency: row.item_billing_frequency ?? null,
        units: null,
        amount,
        currency: row.currency ?? 'EUR',
        purchased_at: row.starts_at ?? null,
        created_at: row.created_at ?? null,
        created_by: row.set_created_by ?? null,
        origin: toItemOrigin(row.origin),
        regular_amount: listPrice ?? amount,
        promotion: lp?.promotions[0] ?? null,
        promotions: lp?.promotions ?? [],
        list_price: listPrice,
        direct_discount_percent: pct,
        direct_discount_amount: pct != null && listPrice != null ? Math.round(((lp ? lp.promotions[lp.promotions.length - 1].final_amount : listPrice) * pct / 100) * 100) / 100 : null,
        tax_rate_percent: null,
        payment_status: null,
        billing_event_id: null,
        source: 'recurring' as const,
        pending_termination: false,
        assigned_member_id: row.assigned_member_id == null ? null : Number(row.assigned_member_id),
        assigned_member_name: row.assigned_member_name ?? null,
      };
    });
  const activeRows: MemberPurchasedProduct[] = rows.map((active: any) => {
    const row = hasDraft ? (draftByRef.get(Number(active.line_ref)) ?? active) : active;
    const { amount: baseAmount, listPrice, pct } = figures(row);
    const lp = linePromos.get(Number(row.id));
    const amount = lp?.final ?? baseAmount;
    return {
      id: -Number(active.id),
      product_id: Number(row.product_id),
      status: active.set_status === 'active' ? 'active' : 'pending_payment',
      product_name: row.item_name,
      product_type: row.item_type,
      billing_frequency: row.item_billing_frequency ?? null,
      units: null,
      amount,
      currency: row.currency ?? 'EUR',
      purchased_at: row.starts_at ?? null,
      created_at: row.created_at ?? null,
      created_by: active.set_created_by ?? null,
      origin: toItemOrigin(row.origin),
      regular_amount: listPrice ?? amount,
      promotion: lp?.promotions[0] ?? null,
      promotions: lp?.promotions ?? [],
      list_price: listPrice,
      direct_discount_percent: pct,
      direct_discount_amount: pct != null && listPrice != null ? Math.round(((lp ? lp.promotions[lp.promotions.length - 1].final_amount : listPrice) * pct / 100) * 100) / 100 : null,
      tax_rate_percent: null,
      payment_status: active.payment_status ?? null,
      billing_event_id: active.billing_event_id == null ? null : Number(active.billing_event_id),
      source: 'recurring' as const,
      pending_termination: active.set_status === 'active' && hasDraft && !draftLineRefs.has(Number(active.line_ref)),
      assigned_member_id: row.assigned_member_id == null ? null : Number(row.assigned_member_id),
      assigned_member_name: row.assigned_member_name ?? null,
    };
  });
  return [...activeRows, ...draftOnly];
}
