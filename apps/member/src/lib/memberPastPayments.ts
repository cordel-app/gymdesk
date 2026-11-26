// #3437 — what the Members App's **Past Payments** subcard decides, and nothing
// it draws: the request a page of it is (`GET /me/billing-events/past`), how a
// page joins the ones already shown, and what the filters are. Which payments
// are past, their order and the filtering are the API's
// (`api/src/domain/pastPaymentsQuery.ts`); this module never filters or sorts a
// payment itself. No `t()` here (`api/src/test/member-past-payments.unit.test.ts`).

import type { MemberBillingEvent } from './memberPayments';

/** The filters at the top of Past Payments. Empty string = not set. */
export interface PastPaymentsFilters {
  dateFrom: string;
  dateTo: string;
  /** A Product id, as the `<select>` holds it. */
  productId: string;
}

export const EMPTY_PAST_FILTERS: PastPaymentsFilters = { dateFrom: '', dateTo: '', productId: '' };

/** One page as the API answers it. */
export interface PastPaymentsPage {
  items: MemberBillingEvent[];
  next_cursor: string | null;
}

/** A Product the filter offers (`GET /me/billing-events/past/products`). */
export interface PastPaymentProductOption {
  id: number;
  name: string;
}

export const PAST_PAYMENTS_PRODUCTS_PATH = '/me/billing-events/past/products';

/** Whether any filter is set. */
export function hasPastFilters(filters: PastPaymentsFilters): boolean {
  return Boolean(filters.dateFrom || filters.dateTo || filters.productId);
}

/**
 * The request for one page: the filters as set, and the cursor of the page
 * before (none for the first). A date range typed backwards is sent as typed:
 * the API refuses it, and `pastFiltersError()` says so before it is sent.
 */
export function pastPaymentsPath(filters: PastPaymentsFilters, cursor: string | null = null): string {
  const params = new URLSearchParams();
  if (filters.dateFrom) params.set('date_from', filters.dateFrom);
  if (filters.dateTo) params.set('date_to', filters.dateTo);
  if (filters.productId) params.set('product_id', filters.productId);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return `/me/billing-events/past${query ? `?${query}` : ''}`;
}

/** The locale key of a filter the API would refuse, or `null`. */
export function pastFiltersError(filters: PastPaymentsFilters): string | null {
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) return 'payments.past_filter_range_invalid';
  return null;
}

/**
 * The list once `page` arrives: the rows already shown, then the page's, each
 * payment once. The cursor already guarantees no repeat; this keeps the list
 * correct should one response be applied twice (a retried request).
 */
export function appendPastPage(shown: MemberBillingEvent[], page: MemberBillingEvent[]): MemberBillingEvent[] {
  const seen = new Set(shown.map((e) => e.id));
  return [...shown, ...page.filter((e) => !seen.has(e.id))];
}
