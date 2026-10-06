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

/** A catalogue row plus what this member has done about it (stage 2, §6). */
export type MemberCatalogueProduct = MemberProduct & ProductPurchaseFields;

/** The columns both reads project — the catalogue's own, plus its tax rate. */
const PRODUCT_COLUMNS = `
  p.id, p.name, p.description, p.type, p.units,
  p.billing_frequency, p.amount, p.currency, p.charge_type_id,
  p.tax_behavior, tr.rate_percent AS tax_rate_percent`;

/**
 * Every Product of the gym a member may be shown, alphabetically, with the
 * state of their own purchases of each.
 *
 * Alphabetical rather than the Products page's `is_system DESC, name` order: a
 * member has no idea which items were seeded, so ordering by it would group the
 * list by a fact that is invisible to them.
 *
 * The purchase states are a second statement rather than a join with an
 * aggregate: a member has at most a handful of live purchases, so one indexed
 * read of their own rows is cheaper to understand than a `GROUP_CONCAT` over
 * the catalogue — and it keeps the catalogue query exactly what stage 1 wrote.
 */
export async function memberProductCatalogue(
  gymId: string,
  memberId: number,
): Promise<MemberCatalogueProduct[]> {
  const [{ rows }, statuses] = await Promise.all([
    db.query<any>(
      `SELECT ${PRODUCT_COLUMNS}
       FROM products p
       LEFT JOIN tax_rates tr ON tr.id = p.tax_rate_id
       WHERE p.gym_id = ? AND ${memberProductCatalogueSql('p')}
       ORDER BY p.name ASC`,
      [gymId, ...memberProductCatalogueParams()],
    ),
    loadPurchaseStatuses(gymId, memberId),
  ]);
  return rows.map((row: any) => {
    const item = shapeMemberProduct(row, grossPrice(row));
    return { ...item, ...describeProductPurchase(item, statuses.get(item.id) ?? []) };
  });
}

/** Each Product this member holds a live purchase of, and in which statuses. */
async function loadPurchaseStatuses(
  gymId: string,
  memberId: number,
): Promise<Map<number, string[]>> {
  const { rows } = await db.query<{ product_id: number; status: string }>(
    `SELECT product_id, status
       FROM member_products
      WHERE gym_id = ? AND member_id = ? AND status <> 'cancelled'`,
    [gymId, memberId],
  );
  const byProduct = new Map<number, string[]>();
  for (const row of rows) {
    const key = Number(row.product_id);
    const list = byProduct.get(key) ?? [];
    list.push(row.status);
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
}

export interface StartPurchaseResult {
  /** The `member_products` row created, pending its payment. */
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

/** MySQL: ER_DUP_ENTRY — the pending-purchase key losing a race. */
const ER_DUP_ENTRY = 1062;

/**
 * Starts a purchase: the provider-side payment, the `payment_requests` row that
 * carries its page token, and the `member_products` row the webhook completes.
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

  const snapshot = purchaseSnapshot({
    name: item.name,
    type: item.type,
    billing_frequency: item.billing_frequency,
    units: item.units,
    price_incl_tax: item.price_incl_tax,
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

      const { insertId } = await tx.query(
        `INSERT INTO member_products
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
    `SELECT id FROM member_products
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
  billingEventId: number | null,
): Promise<number> {
  const { rowCount } = await tx.query(
    // `gym_id` is in the WHERE although `payment_request_id` is unique on its
    // own: every query of a domain table filters by the gym (CLAUDE.md), and
    // the webhook has the request's own `gym_id` in hand.
    `UPDATE member_products
        SET status = 'active', purchased_at = UTC_TIMESTAMP(),
            billing_event_id = ?, modified_at = UTC_TIMESTAMP()
      WHERE gym_id = ? AND payment_request_id = ? AND status = ?`,
    [billingEventId, gymId, paymentRequestId, PENDING_PURCHASE_STATUS],
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
    `UPDATE member_products
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
    `UPDATE member_products mp
       JOIN payment_requests pr ON pr.id = mp.payment_request_id
        SET mp.status = 'cancelled', mp.modified_at = UTC_TIMESTAMP()
      WHERE mp.status = ? AND pr.status IN ('expired', 'failed')`,
    [PENDING_PURCHASE_STATUS],
  );
  return rowCount;
}
