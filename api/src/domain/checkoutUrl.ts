// #1480 — the hosted payment page's URL, and the one place that spells it.
//
//   https://pay.<host>/ca/checkout?token=<page_token>
//
// The page is a static app (`apps/payment`) that renders in the language of the
// first path segment, as the Members App and the Admin App do. Five code paths
// raise a checkout — the member's own Pay now, a staff request, a plan saved for
// payment, a card replacement and a product purchase — and until this module
// each spelled `…/checkout?token=` for itself, so the sixth would have forgotten
// the language. They all end here.
//
// Pure: no DB, no HTTP, no `process.env`. The base URL is an argument and the
// payer's language is decided by the I/O half (`api/src/api/checkout-url.ts`).

/**
 * The languages the payment page has a dictionary for. The payment image cannot
 * import this API's `SUPPORTED_LOCALES` (it is a static nginx app with no build
 * step), so the list is declared on both sides and
 * `api/src/test/checkout-locale.unit.test.ts` fails the build if they drift.
 */
export const CHECKOUT_LOCALES = ['en', 'es', 'ca'] as const;
export type CheckoutLocale = (typeof CHECKOUT_LOCALES)[number];

/** What the page renders when the path names no locale — the pre-#1480 behaviour. */
export const CHECKOUT_FALLBACK_LOCALE: CheckoutLocale = 'es';

export function isCheckoutLocale(value: unknown): value is CheckoutLocale {
  return typeof value === 'string' && (CHECKOUT_LOCALES as readonly string[]).includes(value);
}

/**
 * `<base>/<locale>/checkout?token=<token>`. A locale the page has no dictionary
 * for (a deployment configuring a fourth language) gets the locale-less path,
 * which the page still serves — in Spanish, as before — rather than a segment
 * the nginx rule would refuse.
 */
export function buildCheckoutUrl(base: string, pageToken: string, locale: string | null | undefined): string {
  const root = base.replace(/\/+$/, '');
  const segment = isCheckoutLocale(locale) ? `/${locale}` : '';
  return `${root}${segment}/checkout?token=${encodeURIComponent(pageToken)}`;
}
