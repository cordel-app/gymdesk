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
} from '../domain/memberProductCatalogue';
import {
  type ProductPurchaseFields,
  type PurchaseBlock,
  PENDING_PURCHASE_STATUS,
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
  resolvePurchasePromotion,
  writePurchasePromotion,
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
const PRODUCT_COLUMNS = `
  p.id, p.name, p.description, p.type, p.units,
  p.billing_frequency, p.amount, p.currency, p.charge_type_id,
  p.tax_behavior, tr.rate_percent AS tax_rate_percent`;

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
      WHERE gym_id = ? AND member_id = ? AND status <> 'cancelled'
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
function grossPrice(row: any): number | null {
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
  /** #1118 §5 — the Promotion the member applied, if they applied one. */
  promotionId?: number | null;
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

/** MySQL: ER_DUP_ENTRY — the pending-purchase key losing a race. */
const ER_DUP_ENTRY = 1062;

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
  const { rows } = await db.query<any>(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     LEFT JOIN tax_rates tr ON tr.id = p.tax_rate_id
     WHERE p.gym_id = ? AND p.id = ? AND ${memberProductCatalogueSql('p')}`,
    [input.gymId, input.productId, ...memberProductCatalogueParams()],
  );
  if (!rows[0]) {
    throw Object.assign(new Error('Product not found'), { status: 404 });
  }
  const row = rows[0];
  const item = shapeMemberProduct(row, grossPrice(row));
  const taxRate = row.tax_rate_percent == null ? null : Number(row.tax_rate_percent);

  const pending = await hasPendingPurchase(input.gymId, input.memberId, input.productId);
  const block = productPurchaseBlock(item, pending);
  if (block) throw new PurchaseRefused(block);

  // #1118 §5 — what the member applied, re-read and re-priced now. The
  // purchase is charged the Promotion's Final price, so `member_products_oneoff_snapshot.amount`
  // stays what it has always been: the figure actually charged. The regular
  // price it was discounted from is the application's own
  // (`member_products_oneoff_promotion_snapshot.regular_amount`), which is where §13's *Price*
  // line reads it from.
  const offer = input.promotionId
    ? await resolvePurchasePromotion(input.gymId, input.memberId, {
      id: item.id,
      type: item.type,
      billing_frequency: item.billing_frequency,
      price_incl_tax: item.price_incl_tax,
    }, input.promotionId)
    : null;
  if (input.promotionId && !offer) throw new PromotionRefused();

  const snapshot = purchaseSnapshot({
    name: item.name,
    type: item.type,
    billing_frequency: item.billing_frequency,
    units: item.units,
    price_incl_tax: offer ? offer.final_price_incl_tax : item.price_incl_tax,
    currency: item.currency,
    tax_rate_percent: taxRate,
  });

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
      const { insertId: paymentRequestId } = await tx.query(
        // `user_membership_id` is NULL (migration 228): a purchase belongs to
        // the member, and under #956 they may hold no plan at all.
        // `consent_given_at` is stamped because the member is the one going
        // through the hosted page's consent checkbox, exactly as a
        // customer-initiated fee payment does.
        `INSERT INTO payment_requests
           (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
            status, provider, provider_order, provider_ref, page_token, page_token_expires,
            consent_given_at, source)
         VALUES (?, NULL, ?, ?, ?, ?, 'pending', 'monei', ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
        [
          input.gymId, input.memberId, snapshot.amount.toFixed(2), snapshot.currency,
          row.charge_type_id ?? null,
          orderId, result.providerOrderId, pageToken, pageTokenExpires,
          PRODUCT_PURCHASE_SOURCE,
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
           (gym_id, member_id, event_type, amount, charge_type_id, source, actor_user_id)
         VALUES (?, ?, 'product_purchase', ?, ?, 'provider', NULL)`,
        [input.gymId, input.memberId, snapshot.amount.toFixed(2), row.charge_type_id ?? null],
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
            payment_request_id, created_by_name, created_by_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'member')`,
        [
          input.gymId, input.memberId, input.productId, PENDING_PURCHASE_STATUS,
          snapshot.product_name, snapshot.product_type, snapshot.billing_frequency,
          snapshot.units, snapshot.amount.toFixed(2), snapshot.currency,
          snapshot.tax_rate_percent, paymentRequestId, input.memberName,
        ],
      );

      // #1118 §7 — the application, frozen beside the purchase it priced. In
      // the same transaction for #1121 stage 2's reason: a purchase charged a
      // discounted amount with nothing on file explaining it is exactly what
      // §15's audit questions must never meet.
      if (offer) await writePurchasePromotion(tx, input.gymId, insertId, offer);

      return insertId;
    });

    return {
      purchaseId,
      checkoutUrl: `${process.env.PAYMENT_PAGE_URL ?? 'https://pay.vdicube.com'}/checkout?token=${pageToken}`,
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
  const { rowCount } = await tx.query(
    // `gym_id` is in the WHERE although `payment_request_id` is unique on its
    // own: every query of a domain table filters by the gym (CLAUDE.md), and
    // the webhook has the request's own `gym_id` in hand.
    `UPDATE member_products_oneoff_snapshot
        SET status = 'active', purchased_at = UTC_TIMESTAMP(),
            modified_at = UTC_TIMESTAMP()
      WHERE gym_id = ? AND payment_request_id = ? AND status = ?`,
    [gymId, paymentRequestId, PENDING_PURCHASE_STATUS],
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
        SET status = 'cancelled', modified_at = UTC_TIMESTAMP()
      WHERE gym_id = ? AND payment_request_id = ? AND status = ?`,
    [gymId, paymentRequestId, PENDING_PURCHASE_STATUS],
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
        SET mp.status = 'cancelled', mp.modified_at = UTC_TIMESTAMP()
      WHERE mp.status = ? AND pr.status IN ('expired', 'failed')`,
    [PENDING_PURCHASE_STATUS],
  );
  return rowCount;
}
