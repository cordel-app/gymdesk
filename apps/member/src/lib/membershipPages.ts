// #2737 — My Products shows what the member holds; buying happens on two
// pages of their own. One component renders all three (the route decides which
// part of it is shown), so the plan and product purchasing workflows are moved,
// never copied.
//
// Pure: the paths and the mode a pathname selects. The caller prefixes the locale.

export type MembershipPageMode = 'overview' | 'add_plan' | 'add_product';

/** My Products. */
export const MEMBERSHIP_PATH = '/membership';
/** The Membership Plan purchasing page. */
export const ADD_PLAN_PATH = '/membership/add-plan';
/** The Product purchasing page (One-off, Sessions packages and recurring Products). */
export const ADD_PRODUCT_PATH = '/membership/add-product';

/** Which part of the page a pathname (`/{locale}/membership/…`) shows. */
export function membershipPageMode(pathname: string | null | undefined): MembershipPageMode {
  const segments = (pathname ?? '').split('/').filter(Boolean);
  // segments: [locale, 'membership', sub?]
  if (segments[1] !== 'membership') return 'overview';
  if (segments[2] === 'add-plan') return 'add_plan';
  if (segments[2] === 'add-product') return 'add_product';
  return 'overview';
}

/**
 * #2741 — where the header's back control goes from a page (locale-less; ''
 * is Home). On the two purchasing pages the header already reads
 * "← My Products", so it goes back to My Products and the page draws no second
 * back link of its own; everywhere else it goes Home, as before.
 */
export function headerBackPath(pathname: string | null | undefined): string {
  return membershipPageMode(pathname) === 'overview' ? '' : MEMBERSHIP_PATH;
}

/**
 * #2770 — whether the member may add Plans and Products: the Family Owner (or a
 * member with no family) only. The flag is `GET /me/membership`'s
 * `can_add_plans_and_products`, decided by the API; an absent flag (an older API)
 * keeps the actions, since every add route refuses a non-owner on its own.
 */
export function canAddPlansAndProducts(flag: boolean | null | undefined): boolean {
  return flag !== false;
}

/**
 * #2776 — whether the member sees the Payments tab: the Family Owner (or a
 * member with no family) only. The flag is `GET /me/membership`'s
 * `can_view_payments`, decided by the API; an absent flag (an older API) keeps
 * the tab, since the two reads it draws from refuse a non-owner on their own.
 */
export function canViewPayments(flag: boolean | null | undefined): boolean {
  return flag !== false;
}

/** The tabs of My Products, in order; Payments only for who may view it (#2776). */
export type MembershipTab = 'products' | 'services' | 'payments';
export function membershipTabs(paymentsVisible: boolean): MembershipTab[] {
  return paymentsVisible ? ['products', 'services', 'payments'] : ['products', 'services'];
}

/** The refusal code every add route answers a family member who is not the owner. */
export const FAMILY_OWNER_ONLY = 'family_owner_only';
/** Its locale key. */
export const FAMILY_OWNER_ONLY_KEY = 'membership.family_owner_only';
