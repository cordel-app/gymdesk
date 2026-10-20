import { originOf } from '../domain/itemOrigin';
import { DateTime } from 'luxon';
import { computeValidUntil } from '../domain/productValidity';
import { resolveTimeZone } from '../domain/homeDashboard';
import { SYSTEM_ACTOR } from '../domain/auditActor';
import { ownPurchaseEndDate, ownPurchaseState, type OwnPurchaseState } from '../domain/memberOwnPurchases';
import { loadMemberPurchases } from './member-product-promotions';
// #1121 stages 1 and 2 — the I/O half of the member's own Products: what
// `GET /me/products` answers, and what `POST /me/products/:id/purchase` does.
//
// The split is `me-billing-forecast.ts`' (#1123): the rules live in
// `domain/memberProductCatalogue.ts` (which Products a member may be shown) and
// `domain/memberProductPurchase.ts` (what buying one means), both pure and
// assertable, and this file is the queries, the provider call and the writes.
// There is deliberately nothing else in it — no second predicate, no ordering
// rule of its own and no price arithmetic:
//
//  - the **predicate** is the catalogue module's, and the purchase route reads
//    the Product through the very same fragment, because a member must not be
//    able to buy what they cannot be shown;
//  - the **price** is `computePriceFields()`' (`api/src/api/products.ts`), the
//    one gross-up every other surface quotes (#817: the arithmetic is the
//    server's, never a page's), with the stored amount as the fallback for a
//    gym that has configured no tax rate — exactly `grossBenefitUnitPrice()`'s
//    rule, for the same reason. It is also the figure that is charged and the
//    figure the purchase snapshot keeps;
//  - the **member is never named by the request** (#1036's rule): the routes
//    resolve the caller through `resolveMemberId()` and every statement here is
//    constrained on `(gym_id, member_id)`.

import { payerCheckoutUrl } from './checkout-url';
import crypto from 'crypto';
import { db, type Tx } from '../infra/db';
import { getPaymentProvider } from '../payments';
import { toMinorUnits } from '../payments/money';
import { withPurposeParam } from '../domain/storedCards';
import { computePriceFields } from './products';
import {
  type MemberProduct,
  memberProductCatalogueParams,
  memberProductCatalogueSql,
  shapeMemberProduct,
  staffProductCatalogueSql,
} from '../domain/memberProductCatalogue';
import {
  type PricingRefusal,
  priceProductPurchase,
} from '../domain/productPurchasePricing';
import {
  type ProductPurchaseFields,
  type PurchaseBlock,
  PENDING_PURCHASE_STATUS,
  DRAFT_PURCHASE_STATUS,
  PRODUCT_PURCHASE_SOURCE,
  describeProductPurchase,
  productPurchaseBlock,
  purchaseSnapshot,
} from '../domain/memberProductPurchase';
import {
  type AppliedPromotion,
  type MemberProductPromotionOffer,
} from '../domain/memberProductPromotion';
import {
  loadAppliedPromotions,
  loadPromotionOffers,
  writePurchasePromotionStep,
} from './member-product-promotions';

/**
 * A catalogue row plus what this member has done about it (stage 2, §6) and
 * what their gym is currently offering on it (#1118 §4).
 *
 * `promotions` is what may still be applied; `applied_promotion` is the
 * snapshot of the one a live purchase was actually made under, read from
 * `member_products_oneoff_promotion_snapshot` and never from the live Promotion (§13).
 */
export type MemberCatalogueProduct = MemberProduct & ProductPurchaseFields & {
  promotions: MemberProductPromotionOffer[];
  applied_promotion: AppliedPromotion | null;
};

/**
 * #1189 stage 4 — narrow the catalogue to Products that grant sessions of the
 * named Professional Services (the ones a refused booking said would unlock it).
 * It only ever *narrows* the one catalogue predicate; it never widens it, so a
 * member still cannot be shown what they cannot buy.
 */
function professionalServiceFilterSql(ids: number[]): string {
  if (ids.length === 0) return '';
  const marks = ids.map(() => '?').join(', ');
  return `AND EXISTS (SELECT 1 FROM product_professional_services pps
                       WHERE pps.product_id = p.id AND pps.professional_service_id IN (${marks}))`;
}

/** The columns both reads project — the catalogue's own, plus its tax rate. */
export const PRODUCT_COLUMNS = `
  p.id, p.name, p.description, p.type, p.units,
  p.billing_frequency, p.amount, p.currency, p.charge_type_id,
  p.tax_behavior, p.validity_days, p.image_url, p.image_thumbnail_url,
  tr.rate_percent AS tax_rate_percent`;

/**
 * Every Product of the gym a member may be shown, alphabetically, with the
 * state of their own purchases of each and the Promotions on offer for it.
 *
 * Alphabetical rather than the Products page's `is_system DESC, name` order: a
 * member has no idea which items were seeded, so ordering by it would group the
 * list by a fact that is invisible to them.
 *
 * The purchase states are a second statement rather than a join with an
 * aggregate: a member has at most a handful of live purchases, so one indexed
 * read of their own rows is cheaper to understand than a `GROUP_CONCAT` over
 * the catalogue — and it keeps the catalogue query exactly what stage 1 wrote.
 * The offers (#1118 §4) are a third, for the same reason and because they are
 * `domain/memberProductPromotion.ts`' rule rather than the catalogue's: the
 * Products a member may see is still the one predicate stage 1 wrote, with no
 * knowledge of Promotions in it.
 */
export async function memberProductCatalogue(
  gymId: string,
  memberId: number,
  professionalServiceIds: number[] = [],
): Promise<MemberCatalogueProduct[]> {
  const [{ rows }, purchases] = await Promise.all([
    db.query<any>(
      `SELECT ${PRODUCT_COLUMNS}
       FROM products p
       LEFT JOIN tax_rates tr ON tr.id = p.tax_rate_id
       WHERE p.gym_id = ? AND ${memberProductCatalogueSql('p')}
       ${professionalServiceFilterSql(professionalServiceIds)}
       ORDER BY p.name ASC`,
      [gymId, ...memberProductCatalogueParams(), ...professionalServiceIds],
    ),
    loadLivePurchases(gymId, memberId),
  ]);

  const items = rows.map((row: any) => shapeMemberProduct(row, grossPrice(row)));
  const [offers, applied] = await Promise.all([
    loadPromotionOffers(gymId, memberId, items.map((item) => ({
      id: item.id,
      type: item.type,
      billing_frequency: item.billing_frequency,
      price_incl_tax: item.price_incl_tax,
    }))),
    loadAppliedPromotions(
      gymId,
      [...purchases.values()].map((rowsForProduct) => rowsForProduct.map((r) => r.id)).flat(),
    ),
  ]);

  return items.map((item) => {
    const own = purchases.get(item.id) ?? [];
    const purchase = describeProductPurchase(item, own.map((r) => r.status));
    // The live purchase this state is about, in `purchaseStateFor()`'s own
    // precedence — a checkout in flight outranks a completed purchase — so the
    // card cannot report one state and the Promotion of another.
    const live = own.find((r) => r.status === 'pending_payment')
      ?? own.find((r) => r.status === 'active')
      ?? null;
    return {
      ...item,
      ...purchase,
      // A Product the member already holds or is paying for is not on offer
      // again: the Buy action is gone (§6), so an *Apply promotion* beside it
      // would act on nothing.
      promotions: purchase.purchase_state === 'available' ? offers.get(item.id) ?? [] : [],
      applied_promotion: live ? applied.get(live.id) ?? null : null,
    };
  });
}

/**
 * Each live (non-cancelled) purchase this member holds, by Product.
 *
 * It carries the row ids as well as the statuses, because the catalogue reports
 * the Promotion a live purchase was made under beside its state (§5's "the
 * Promotion is shown as applied"), and that snapshot is keyed on the purchase.
 */
async function loadLivePurchases(
  gymId: string,
  memberId: number,
): Promise<Map<number, { id: number; status: string }[]>> {
  const { rows } = await db.query<{ id: number; product_id: number; status: string }>(
    `SELECT id, product_id, status
       FROM member_products_oneoff_snapshot
      WHERE gym_id = ? AND member_id = ? AND status IN ('pending_payment', 'active')
      ORDER BY id DESC`,
    [gymId, memberId],
  );
  const byProduct = new Map<number, { id: number; status: string }[]>();
  for (const row of rows) {
    const key = Number(row.product_id);
    const list = byProduct.get(key) ?? [];
    list.push({ id: Number(row.id), status: row.status });
    byProduct.set(key, list);
  }
  return byProduct;
}

/** The VAT-inclusive price of one catalogue row, or `null` for an unpriced one. */
export function grossPrice(row: any): number | null {
  if (row.amount == null) return null;
  const { amount_incl_tax } = computePriceFields(row);
  return amount_incl_tax ?? Number(row.amount);
}

export interface StartPurchaseInput {
  gymId: string;
  memberId: number;
  memberName: string;
  memberEmail: string;
  productId: number;
  /** #1480: the member's own request language (the payer is the caller). */
  requestLocale?: string | null;
  /** #1118 §5 — the Promotion the member applied, if they applied one. */
  promotionId?: number | null;
  /**
   * #1521 — every Promotion applied, in the order they price the running
   * figure. Takes precedence over `promotionId`.
   */
  promotionIds?: number[];
  /**
   * #1521 — an Admin's direct discount, a percentage of the VAT-inclusive
   * price after Promotions. Only the staff route ever passes it.
   */
  directDiscountPercent?: number | null;
  /**
   * #1521 — the purchase is being made by staff for this member: the Product is
   * read through the staff catalogue and `actorName` is the creator recorded.
   */
  staff?: { actorName: string };
  /**
   * #1657 stage 2 — the staff draft this payment starts from. The draft is
   * deleted in the same transaction that writes the pending purchase, so it is
   * promoted rather than duplicated; it is never touched when the provider or
   * the pricing refuses.
   */
  fromDraftId?: number;
}

export interface StartPurchaseResult {
  /** The `member_products_oneoff_snapshot` row created, pending its payment. */
  purchaseId: number;
  /** The hosted page the member types their card on. */
  checkoutUrl: string;
  amount: number;
  currency: string;
}

/** Thrown for a Product this member may not buy; the route answers its body. */
export class PurchaseRefused extends Error {
  constructor(readonly block: PurchaseBlock) {
    super(block);
  }
}

/**
 * Thrown for a Promotion the member named that is no longer on offer for this
 * Product — expired, switched off, re-configured, or never theirs to apply.
 *
 * It is a refusal rather than a silent fall-back to the regular price, because
 * the member is looking at a Final price they chose: charging a different one
 * without saying so is the one outcome §8's "must always be able to see the
 * actual final price before completing the purchase" rules out.
 */
export class PromotionRefused extends Error {
  constructor() {
    super('promotion_not_applicable');
  }
}

/** #1521 — the stack of Promotions and discount the purchase asked for cannot be priced. */
export class PricingRefused extends Error {
  constructor(readonly refusal: PricingRefusal) {
    super(refusal);
  }
}

/** MySQL: ER_DUP_ENTRY — the pending-purchase key losing a race. */
const ER_DUP_ENTRY = 1062;

/** What a purchase is priced and frozen as, before anything is written. */
async function resolvePurchase(input: StartPurchaseInput, ignoreDraftId?: number) {
  const catalogueSql = input.staff ? staffProductCatalogueSql('p') : memberProductCatalogueSql('p');
  const catalogueParams = input.staff ? [] : memberProductCatalogueParams();
  const { rows } = await db.query<any>(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     LEFT JOIN tax_rates tr ON tr.id = p.tax_rate_id
     WHERE p.gym_id = ? AND p.id = ? AND ${catalogueSql}`,
    [input.gymId, input.productId, ...catalogueParams],
  );
  if (!rows[0]) {
    throw Object.assign(new Error('Product not found'), { status: 404 });
  }
  const row = rows[0];
  const item = shapeMemberProduct(row, grossPrice(row));
  const taxRate = row.tax_rate_percent == null ? null : Number(row.tax_rate_percent);
  const actorName = input.staff?.actorName ?? input.memberName;

  const pending = await hasPendingPurchase(input.gymId, input.memberId, input.productId);
  // #1657: staff hold at most one draft per Product; a payment started *from*
  // that draft is the one place it is expected.
  if (input.staff && (await hasDraftPurchase(input.gymId, input.memberId, input.productId, ignoreDraftId))) {
    throw new PurchaseRefused('draft_exists');
  }
  // #1864: holding the Product already is no reason to refuse; each purchase is its own row.
  const block = productPurchaseBlock(item, pending);
  if (block) throw new PurchaseRefused(block);

  // #1118 §5 / #1521 — what was applied, re-read and re-priced now. Every
  // Promotion is re-resolved through the loader that produced the offer, and
  // the whole stack is priced by the one pure module, so the charge is the
  // figure the quote showed or the purchase is refused.
  const promotionIds = input.promotionIds
    ?? (input.promotionId ? [input.promotionId] : []);
  const offers = promotionIds.length > 0
    ? (await loadPromotionOffers(input.gymId, input.memberId, [{
      id: item.id,
      type: item.type,
      billing_frequency: item.billing_frequency,
      price_incl_tax: item.price_incl_tax,
    }])).get(item.id) ?? []
    : [];
  const chosen: MemberProductPromotionOffer[] = [];
  for (const id of promotionIds) {
    const offer = offers.find((o) => o.promotion_id === id);
    if (!offer) throw new PromotionRefused();
    chosen.push(offer);
  }
  const priced = priceProductPurchase({
    listPrice: item.price_incl_tax,
    promotions: chosen.map((o) => ({
      promotion_id: o.promotion_id,
      promotion_name: o.promotion_name,
      action: o.action,
      value: o.value,
      duration_cycles: o.duration_cycles,
      stackable: o.stackable,
    })),
    directDiscountPercent: input.directDiscountPercent ?? null,
  });
  if (!priced.ok) throw new PricingRefused(priced.refusal);
  const price = priced.price;

  const snapshot = purchaseSnapshot({
    name: item.name,
    type: item.type,
    billing_frequency: item.billing_frequency,
    units: item.units,
    price_incl_tax: price.final_price,
    currency: item.currency,
    tax_rate_percent: taxRate,
  });

  return { row, snapshot, price, actorName };
}

/**
 * #1657 stage 2 — staff **Save** of a one-time Product: the purchase row and
 * its Promotion snapshots in `draft`, with no payment request, no Billing
 * Event and no provider call. Priced and frozen exactly as a paid purchase is,
 * so the draft shows what Pay will charge; Pay re-resolves it anyway.
 */
export async function saveProductPurchaseDraft(
  input: StartPurchaseInput,
): Promise<{ purchaseId: number; amount: number; currency: string }> {
  const { snapshot, price, actorName } = await resolvePurchase(input);
  const purchaseId = await db.transaction(async (tx) => {
    const { insertId } = await tx.query(
      `INSERT INTO member_products_oneoff_snapshot
         (gym_id, member_id, product_id, status,
          product_name, product_type, billing_frequency, units,
          amount, currency, tax_rate_percent,
          payment_request_id, created_by,
          list_price, direct_discount_percent, direct_discount_amount, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      [
        input.gymId, input.memberId, input.productId, DRAFT_PURCHASE_STATUS,
        snapshot.product_name, snapshot.product_type, snapshot.billing_frequency,
        snapshot.units, snapshot.amount.toFixed(2), snapshot.currency,
        snapshot.tax_rate_percent, actorName,
        price.list_price.toFixed(2),
        price.direct_discount_percent == null ? null : price.direct_discount_percent.toFixed(2),
        price.direct_discount_amount == null ? null : price.direct_discount_amount.toFixed(2),
        originOf(!!input.staff),
      ],
    );
    for (const step of price.promotions) {
      await writePurchasePromotionStep(tx, input.gymId, insertId, step);
    }
    return insertId;
  });
  return { purchaseId, amount: snapshot.amount, currency: snapshot.currency };
}

/**
 * #1657 stage 2 — **Cancel** of a draft: a hard delete, restricted to this
 * member's own `draft` row so it can never reach a pending or paid purchase.
 */
export async function deletePurchaseDraft(
  gymId: string,
  memberId: number,
  purchaseId: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number }>(
      `SELECT id FROM member_products_oneoff_snapshot
        WHERE id = ? AND gym_id = ? AND member_id = ? AND status = ?
        FOR UPDATE`,
      [purchaseId, gymId, memberId, DRAFT_PURCHASE_STATUS],
    );
    if (!rows[0]) return false;
    await tx.query(
      'DELETE FROM member_products_oneoff_promotion_snapshot WHERE gym_id = ? AND member_product_id = ?',
      [gymId, purchaseId],
    );
    await tx.query(
      'DELETE FROM member_products_oneoff_snapshot WHERE id = ? AND gym_id = ? AND status = ?',
      [purchaseId, gymId, DRAFT_PURCHASE_STATUS],
    );
    return true;
  });
}

/** One draft of this Product for this member, other than `ignoreId`. */
async function hasDraftPurchase(
  gymId: string,
  memberId: number,
  productId: number,
  ignoreId?: number,
): Promise<boolean> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM member_products_oneoff_snapshot
      WHERE gym_id = ? AND member_id = ? AND product_id = ? AND status = ?
      LIMIT 2`,
    [gymId, memberId, productId, DRAFT_PURCHASE_STATUS],
  );
  return rows.some((r) => Number(r.id) !== ignoreId);
}

/**
 * Starts a purchase: the provider-side payment, the `payment_requests` row that
 * carries its page token, and the `member_products_oneoff_snapshot` row the webhook completes.
 *
 * Four things about it are the rule rather than the implementation.
 *
 *  - **The Product is read through the catalogue's own predicate**, so a
 *    `staff_only`, inactive or deleted Product is a 404 here exactly as it is
 *    absent there. Two spellings of "may this member see it" is how a member
 *    comes to buy something they were never offered.
 *  - **The amount is the quoted one.** `grossPrice()` is the same figure
 *    `GET /me/products` showed, converted once by `toMinorUnits()` at the
 *    provider boundary (CLAUDE.md: euros on our side, cents on theirs) — there
 *    is no second pricing path and nothing recomputes tax.
 *  - **The purchase row is written `pending_payment`, before the member pays.**
 *    A row created on the *return* from the hosted page would be lost whenever
 *    the member closed the tab, and a webhook retry would create a second one;
 *    created here, the webhook's own "already processed, skipping" guard plus
 *    `UNIQUE (payment_request_id)` make completion idempotent (#1118 §10).
 *  - **It commits both rows together.** A payment request with no purchase
 *    behind it would take the member's money for nothing identifiable, so the
 *    two INSERTs are one transaction and a lost race on the pending key
 *    (`ER_DUP_ENTRY`) is reported as the 409 the route would have answered.
 *  - **An applied Promotion is re-resolved here, not trusted from the client**
 *    (#1118 §5). The member names a `promotion_id`; this route asks
 *    `domain/memberProductPromotion.ts`' one rule again — through the very
 *    loader that produced the offer — and prices the charge from the answer, so
 *    a Promotion that expired or was re-configured between the quote and the
 *    Buy refuses the purchase instead of charging a price the gym no longer
 *    offers. The **snapshot is written in this same transaction** (§7): the
 *    application belongs to the purchase (§7 binds it to "the resulting
 *    purchase"), so there is nothing for it to hang off before one exists —
 *    which is also why tapping *Apply promotion* persists nothing and leaves no
 *    orphan rows behind every member who changes their mind.
 */
export async function startProductPurchase(
  input: StartPurchaseInput,
): Promise<StartPurchaseResult> {
  const { row, snapshot, price, actorName } = await resolvePurchase(input, input.fromDraftId);

  const orderId = crypto.randomUUID();
  const pageToken = crypto.randomUUID();
  const pageTokenExpires = new Date(Date.now() + 10 * 60 * 1000);

  const provider = getPaymentProvider();
  const result = await provider.createPaymentRequest({
    orderId,
    amount: toMinorUnits(snapshot.amount),
    currency: snapshot.currency,
    description: snapshot.product_name,
    memberEmail: input.memberEmail,
    // The return pages are told what came back, the way #788 established —
    // here so the hosted page's own consent sentence, and anything the member
    // app later renders, can say "purchase" rather than "membership fee".
    okUrl: withPurposeParam(process.env.PAYMENT_OK_URL ?? '', 'product_purchase'),
    koUrl: withPurposeParam(process.env.PAYMENT_KO_URL ?? '', 'product_purchase'),
    notificationUrl: process.env.PAYMENT_NOTIFICATION_URL ?? '',
  });

  try {
    const purchaseId = await db.transaction(async (tx) => {
      if (input.fromDraftId != null) {
        // The draft is promoted, not duplicated: gone in the transaction that
        // writes its pending replacement (#1657).
        await tx.query(
          'DELETE FROM member_products_oneoff_promotion_snapshot WHERE gym_id = ? AND member_product_id = ?',
          [input.gymId, input.fromDraftId],
        );
        await tx.query(
          `DELETE FROM member_products_oneoff_snapshot WHERE id = ? AND gym_id = ? AND member_id = ? AND status = 'draft'`,
          [input.fromDraftId, input.gymId, input.memberId],
        );
      }
      const { insertId: paymentRequestId } = await tx.query(
        // `user_membership_id` is NULL (migration 228): a purchase belongs to
        // the member, and under #956 they may hold no plan at all.
        // `consent_given_at` is stamped because the member is the one going
        // through the hosted page's consent checkbox, exactly as a
        // customer-initiated fee payment does.
        `INSERT INTO payment_requests
           (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
            status, provider, provider_order, provider_ref, page_token, page_token_expires,
            consent_given_at, source, created_by)
         VALUES (?, NULL, ?, ?, ?, ?, 'pending', 'monei', ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)`,
        [
          input.gymId, input.memberId, snapshot.amount.toFixed(2), snapshot.currency,
          row.charge_type_id ?? null,
          orderId, result.providerOrderId, pageToken, pageTokenExpires,
          PRODUCT_PURCHASE_SOURCE, actorName,
        ],
      );

      // The purchase's Billing Event is written with the request, before the
      // money moves (#1325 PR 2): a `product_purchase` event whose derived
      // status is `pending` until the provider confirms, so a request always
      // has an event and the webhook settles it instead of inserting one. It
      // belongs to no ProductSet and no assignment — a one-off purchase sits
      // outside the version chain — so both keys stay NULL.
      const { insertId: billingEventId } = await tx.query(
        `INSERT INTO billing_events
           (gym_id, member_id, event_type, amount, charge_type_id, source, created_by)
         VALUES (?, ?, 'product_purchase', ?, ?, 'provider', ?)`,
        [input.gymId, input.memberId, snapshot.amount.toFixed(2), row.charge_type_id ?? null, actorName],
      );
      await tx.query(
        `UPDATE payment_requests SET billing_event_id = ? WHERE id = ? AND gym_id = ?`,
        [billingEventId, paymentRequestId, input.gymId],
      );

      const { insertId } = await tx.query(
        `INSERT INTO member_products_oneoff_snapshot
           (gym_id, member_id, product_id, status,
            product_name, product_type, billing_frequency, units,
            amount, currency, tax_rate_percent,
            payment_request_id, created_by,
            list_price, direct_discount_percent, direct_discount_amount, validity_days, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.gymId, input.memberId, input.productId, PENDING_PURCHASE_STATUS,
          snapshot.product_name, snapshot.product_type, snapshot.billing_frequency,
          snapshot.units, snapshot.amount.toFixed(2), snapshot.currency,
          snapshot.tax_rate_percent, paymentRequestId, actorName,
          price.list_price.toFixed(2),
          price.direct_discount_percent == null ? null : price.direct_discount_percent.toFixed(2),
          price.direct_discount_amount == null ? null : price.direct_discount_amount.toFixed(2),
          // #1693: the validity agreed at purchase time.
          row.validity_days == null ? null : Number(row.validity_days),
          originOf(!!input.staff),
        ],
      );

      // #1118 §7 — the application, frozen beside the purchase it priced. In
      // the same transaction for #1121 stage 2's reason: a purchase charged a
      // discounted amount with nothing on file explaining it is exactly what
      // §15's audit questions must never meet.
      for (const step of price.promotions) {
        await writePurchasePromotionStep(tx, input.gymId, insertId, step);
      }

      return insertId;
    });

    return {
      purchaseId,
      checkoutUrl: await payerCheckoutUrl({
        gymId: input.gymId, memberId: input.memberId, pageToken, requestLocale: input.requestLocale,
      }),
      amount: snapshot.amount,
      currency: snapshot.currency,
    };
  } catch (err: any) {
    if (err?.errno === ER_DUP_ENTRY) throw new PurchaseRefused('purchase_pending');
    throw err;
  }
}

/** Whether this member already has a checkout in flight for this Product. */
async function hasPendingPurchase(
  gymId: string,
  memberId: number,
  productId: number,
): Promise<boolean> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM member_products_oneoff_snapshot
      WHERE gym_id = ? AND member_id = ? AND product_id = ? AND status = ?
      LIMIT 1`,
    [gymId, memberId, productId, PENDING_PURCHASE_STATUS],
  );
  return rows.length > 0;
}

/**
 * The purchase a payment request paid for becomes the member's.
 *
 * Constrained on `status = 'pending_payment'`, so a webhook delivered twice
 * completes one row and the second pass changes nothing — the idempotency
 * #1118 §10 asks for, stated in the `UPDATE` rather than trusted to the caller.
 */
export async function completeProductPurchase(
  tx: Tx,
  gymId: string,
  paymentRequestId: number,
): Promise<number> {
  // #1693: the purchase day is the gym's calendar day of the confirmation, and
  // the end date is computed once, here. The UPDATE below is still constrained on
  // `pending_payment`, so a duplicate webhook rewrites neither date.
  const { rows: pending } = await tx.query<any>(
    `SELECT mp.id, mp.validity_days, mp.billing_frequency, g.time_zone
       FROM member_products_oneoff_snapshot mp
       JOIN gyms g ON g.id = mp.gym_id
      WHERE mp.gym_id = ? AND mp.payment_request_id = ? AND mp.status = ?`,
    [gymId, paymentRequestId, PENDING_PURCHASE_STATUS],
  );
  if (!pending[0]) return 0;
  const purchasedOn = DateTime.now().setZone(resolveTimeZone(pending[0].time_zone)).toISODate()!;
  const validUntil = computeValidUntil({
    purchasedOn,
    validityDays: pending[0].validity_days == null ? null : Number(pending[0].validity_days),
    billingFrequency: pending[0].billing_frequency ?? null,
  });
  const { rowCount } = await tx.query(
    // `gym_id` is in the WHERE although `payment_request_id` is unique on its
    // own: every query of a domain table filters by the gym (CLAUDE.md), and
    // the webhook has the request's own `gym_id` in hand.
    `UPDATE member_products_oneoff_snapshot
        SET status = 'active', purchased_at = UTC_TIMESTAMP(), valid_until = ?,
            modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE gym_id = ? AND payment_request_id = ? AND status = ?`,
    // The provider's confirmation is the system's act, not the member's (#1182).
    [validUntil, SYSTEM_ACTOR, gymId, paymentRequestId, PENDING_PURCHASE_STATUS],
  );
  return rowCount;
}

/**
 * A purchase whose payment failed or expired.
 *
 * `cancelled` rather than deletion: the attempt is part of what happened to the
 * member, and the row is what `payment_requests.billing_event_id`'s sibling FK
 * hangs off. It also frees the pending key, so the member can try again — which
 * is the whole reason the third status exists.
 */
export async function cancelProductPurchase(
  conn: Pick<typeof db, 'query'> | Tx,
  gymId: string,
  paymentRequestId: number,
): Promise<number> {
  const { rowCount } = await conn.query(
    `UPDATE member_products_oneoff_snapshot
        SET status = 'cancelled', modified_at = UTC_TIMESTAMP(), modified_by = ?
      WHERE gym_id = ? AND payment_request_id = ? AND status = ?`,
    [SYSTEM_ACTOR, gymId, paymentRequestId, PENDING_PURCHASE_STATUS],
  );
  return rowCount;
}

/**
 * Every purchase still `pending_payment` whose payment is no longer pending.
 *
 * The third writer of that status, and the safety net under the other two: a
 * request `POST /billing/cleanup` has expired (#789's two deadlines) or a
 * `failed` webhook that never reached us leaves a purchase that can never
 * complete — and, because the pending key is UNIQUE, one that would block the
 * member from ever buying that Product again. Keyed on the request's own status
 * rather than on a clock of its own, so there is no second definition of when a
 * payment attempt is over.
 *
 * The one read here with no `gym_id` in it, and deliberately: like the nightly
 * run it is called once for the whole deployment by an internal route, not on
 * behalf of a tenant, so narrowing it to a gym would mean asking it per gym.
 */
export async function cancelAbandonedPurchases(
  conn: Pick<typeof db, 'query'> = db,
): Promise<number> {
  const { rowCount } = await conn.query(
    `UPDATE member_products_oneoff_snapshot mp
       JOIN payment_requests pr ON pr.id = mp.payment_request_id
        SET mp.status = 'cancelled', mp.modified_at = UTC_TIMESTAMP(), mp.modified_by = ?
      WHERE mp.status = ? AND pr.status IN ('expired', 'failed')`,
    [SYSTEM_ACTOR, PENDING_PURCHASE_STATUS],
  );
  return rowCount;
}


/**
 * #1862 — the member's own purchased Products, as My Products and Services lists
 * them: the purchases `loadMemberPurchases()` already reads (the staff list's
 * source, so the two cannot disagree), narrowed by `ownPurchaseState()` to what
 * a member is shown and tagged with the state and end date the card draws.
 */
export async function loadOwnPurchases(gymId: string, memberId: number) {
  const { rows } = await db.query<any>('SELECT time_zone FROM gyms WHERE id = ?', [gymId]);
  const today = DateTime.now().setZone(resolveTimeZone(rows[0]?.time_zone)).toISODate()!;
  const items: Array<Record<string, any> & { own_state: OwnPurchaseState; end_date: string | null }> = [];
  for (const p of await loadMemberPurchases(gymId, memberId)) {
    // A recurring line (a ProductSet's, negative id) is active or awaiting
    // payment and has no cancellation of its own.
    const row = { status: p.status, valid_until: p.valid_until ?? null, cancelled_on: p.cancelled_on ?? null };
    const state = ownPurchaseState(row, today);
    if (!state) continue;
    items.push({ ...p, own_state: state, end_date: ownPurchaseEndDate(row) });
  }
  return items;
}

/**
 * #1862 — *Pay* on a purchase awaiting payment. The pending `payment_requests`
 * row already carries the provider payment, so this only issues a fresh page
 * token for it (the old one is spent once the page was opened) — no second
 * provider payment, so the member cannot be charged twice.
 */
export async function reissuePurchaseCheckout(input: {
  gymId: string; memberId: number; purchaseId: number; requestLocale?: string;
}): Promise<{ checkoutUrl: string } | null> {
  const { rows } = await db.query<any>(
    `SELECT pr.id FROM member_products_oneoff_snapshot mp
       JOIN payment_requests pr ON pr.id = mp.payment_request_id AND pr.gym_id = mp.gym_id
      WHERE mp.id = ? AND mp.gym_id = ? AND mp.member_id = ?
        AND mp.status = ? AND pr.status = 'pending'`,
    [input.purchaseId, input.gymId, input.memberId, PENDING_PURCHASE_STATUS],
  );
  if (!rows[0]) return null;
  const pageToken = crypto.randomUUID();
  await db.query(
    `UPDATE payment_requests SET page_token = ?, page_token_expires = ? WHERE id = ? AND gym_id = ? AND status = 'pending'`,
    [pageToken, new Date(Date.now() + 10 * 60 * 1000), rows[0].id, input.gymId],
  );
  return {
    checkoutUrl: await payerCheckoutUrl({
      gymId: input.gymId, memberId: input.memberId, pageToken, requestLocale: input.requestLocale,
    }),
  };
}
