// #1121 stage 1 — which Products a member may be shown, and what they are
// shown of each one.
//
// §7 is the load-bearing sentence of the ticket: do not create a separate
// product catalogue for Members — the availability, pricing and configuration
// come from the existing Product model. So there is no member-facing table, no
// `member_purchasable` column and no second catalogue here: only a **predicate
// over `products`** and the shape of one row of it.
//
// Four of its answers are the rule rather than the implementation.
//
//  - **Two columns decide it, and they are the gym's own configuration**
//    (`Q1` on the thread): `status = 'active'` **and**
//    `enrollment_status = 'public'`. `enrollment_status` is what the Products
//    editor already means by *Public* vs *Staff Only*, so a gym opts a Product
//    into the member's catalogue by the control it already has — which is why
//    the ticket needed no new flag and no migration. `staff_only` is therefore
//    not "hidden from the list"; it is not in the catalogue at all.
//  - **A System item is not excluded.** `is_system` says a Product was seeded
//    from `charge_types`, not that it is internal: a Locker Rental is a System
//    row and a public one (#1149), and filtering on `is_system` would be this
//    module deciding what a gym already decided. The same holds for `mandatory`
//    (#832/#893), which is a *Membership Plan* question.
//  - **Nothing here is about a purchase.** Stage 1 is a read: the catalogue says
//    what exists, never what the member holds, so this module has no state, no
//    status and no "already purchased" answer. That is stage 2's
//    (`member_products`, the thread's `Q2`), and it will add a field to the
//    shape below rather than a second predicate beside it.
//  - **The price is the server's, grossed up once.** `shapeMemberProduct()`
//    takes the VAT-inclusive figure its caller computed through
//    `computePriceFields()` and never multiplies, divides or re-rates anything,
//    because #817's rule is that a page does no tax arithmetic and #942's is
//    that a Sessions Product's `amount` is the price of the **whole package** —
//    `units` travels beside it so the Members App can say so, never so that
//    something can divide by it.

/** The two column values that put a Product in a member's catalogue. */
export const MEMBER_CATALOGUE_STATUS = 'active';
export const MEMBER_CATALOGUE_ENROLLMENT = 'public';

/**
 * The predicate, as a SQL fragment over an alias of `products`.
 *
 * It is a fragment rather than a whole query because the catalogue is read
 * from one place today and a later stage will need the same rule inside a
 * purchase's own validation — a member must not be able to buy what they
 * cannot be shown, and two spellings of "may this member see it" is how that
 * happens. The caller appends it to its own `gym_id` scope and passes
 * `memberProductCatalogueParams()` in the same order.
 */
export function memberProductCatalogueSql(alias = 'p'): string {
  return `${alias}.deleted_at IS NULL AND ${alias}.status = ? AND ${alias}.enrollment_status = ?`;
}

/** The two bound values `memberProductCatalogueSql()` expects, in order. */
export function memberProductCatalogueParams(): string[] {
  return [MEMBER_CATALOGUE_STATUS, MEMBER_CATALOGUE_ENROLLMENT];
}

/**
 * One Product as the member is shown it.
 *
 * `price_incl_tax` is the only money field: there is deliberately no net
 * amount and no tax rate percentage, because a member is quoted the price they
 * pay and `tax_included` says whether a statutory rate is behind it (`null`
 * where the gym has configured none — a claim about tax is not made where
 * there is no rate to claim, which is #942's `taxNoteKey()` answering `null`,
 * one app over).
 */
export interface MemberProduct {
  id: number;
  name: string;
  description: string | null;
  type: string;
  /** The sessions a Sessions package contains; `null` for every other type. */
  units: number | null;
  billing_frequency: string | null;
  price_incl_tax: number | null;
  currency: string;
  tax_included: boolean;
}

/** The columns `shapeMemberProduct()` reads, as mysql2 hands them back. */
export interface MemberProductRow {
  id: number | string;
  name: string;
  description?: string | null;
  type: string;
  units?: number | string | null;
  billing_frequency?: string | null;
  currency?: string | null;
  tax_rate_percent?: number | string | null;
}

/**
 * One catalogue row, shaped for the wire.
 *
 * `priceInclTax` is the caller's: it is the one figure
 * `computePriceFields()` produced, with the stored amount as its fallback for
 * an item whose gym has no tax rate (`grossBenefitUnitPrice()`'s own rule), and
 * `null` for an item carrying no price at all — which is not €0.00 and reads
 * as `—`.
 */
export function shapeMemberProduct(row: MemberProductRow, priceInclTax: number | null): MemberProduct {
  const units = row.units == null ? null : Number(row.units);
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description ?? null,
    type: row.type,
    units: units != null && Number.isFinite(units) ? units : null,
    billing_frequency: row.billing_frequency ?? null,
    price_incl_tax: priceInclTax,
    currency: row.currency ?? 'EUR',
    tax_included: row.tax_rate_percent != null,
  };
}
