/**
 * #3243 — a successful write through `apiFetch` is announced on `window`, so a
 * screen that shows a derived value (the Member card's tab badges) can read it
 * again after an edit made by a section it does not own, without a page reload.
 * The event carries the request path and method only; it decides nothing.
 */
export const API_MUTATION_EVENT = 'gd:api-mutation';

export interface ApiMutationDetail { path: string; method: string }

export function isMutationMethod(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

export function notifyApiMutation(path: string, method: string): void {
  if (typeof window === 'undefined' || !isMutationMethod(method)) return;
  try {
    window.dispatchEvent(new CustomEvent<ApiMutationDetail>(API_MUTATION_EVENT, { detail: { path, method: method.toUpperCase() } }));
  } catch { /* a courtesy: never fail the write that already succeeded */ }
}

/**
 * The writes that can change what the Products tab badge counts: a plan
 * assignment, a Product Set (a recurring line, Save & Pay, activation, cancel),
 * a staff purchase, and a payment settled from Payments (which activates a set).
 */
const PRODUCTS_PATHS = [/^\/user-memberships(\/|\?|$)/, /^\/product-sets(\/|\?|$)/, /^\/members\/\d+\/product-purchases(\/|\?|$)/,
  /^\/membership-plans\/\d+\/assign(\/|\?|$)/, /^\/payments(\/|\?|$)/, /^\/payment-requests(\/|\?|$)/];

export function affectsMemberProducts(path: string): boolean {
  return PRODUCTS_PATHS.some((re) => re.test(path));
}
