// #1121 stage 1 — the I/O half of the member's own Product catalogue: what
// `GET /me/products` answers.
//
// The split is `me-billing-forecast.ts`' (#1123): the rule lives in
// `domain/memberProductCatalogue.ts`, which is pure and assertable, and this
// file is the query. There is deliberately nothing else in it — no filtering, no
// ordering rule of its own and no price arithmetic:
//
//  - the **predicate** is the domain module's, so a later stage that validates a
//    purchase asks the same question rather than restating it;
//  - the **price** is `computePriceFields()`' (`api/src/api/products.ts`), the
//    one gross-up every other surface quotes (#817: the arithmetic is the
//    server's, never a page's), with the stored amount as the fallback for a
//    gym that has configured no tax rate — exactly `grossBenefitUnitPrice()`'s
//    rule, for the same reason;
//  - the **member is never named by the request**: the route resolves the caller
//    through `resolveMemberId()` and this function takes a gym, because the
//    catalogue is the gym's and the same for every member of it. Stage 2's
//    purchase state is per member and will be joined onto these rows; the
//    catalogue itself has no member in it.

import { db } from '../infra/db';
import { computePriceFields } from './products';
import {
  type MemberProduct,
  memberProductCatalogueParams,
  memberProductCatalogueSql,
  shapeMemberProduct,
} from '../domain/memberProductCatalogue';

/**
 * Every Product of the gym a member may be shown, alphabetically.
 *
 * Alphabetical rather than the Products page's `is_system DESC, name` order: a
 * member has no idea which items were seeded, so ordering by it would group the
 * list by a fact that is invisible to them.
 */
export async function memberProductCatalogue(gymId: string): Promise<MemberProduct[]> {
  const { rows } = await db.query<any>(
    `SELECT
       p.id, p.name, p.description, p.type, p.units,
       p.billing_frequency, p.amount, p.currency,
       p.tax_behavior, tr.rate_percent AS tax_rate_percent
     FROM products p
     LEFT JOIN tax_rates tr ON tr.id = p.tax_rate_id
     WHERE p.gym_id = ? AND ${memberProductCatalogueSql('p')}
     ORDER BY p.name ASC`,
    [gymId, ...memberProductCatalogueParams()],
  );
  return rows.map((row: any) => shapeMemberProduct(row, grossPrice(row)));
}

/** The VAT-inclusive price of one catalogue row, or `null` for an unpriced one. */
function grossPrice(row: any): number | null {
  if (row.amount == null) return null;
  const { amount_incl_tax } = computePriceFields(row);
  return amount_incl_tax ?? Number(row.amount);
}
