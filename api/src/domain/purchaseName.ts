// #3288 — the one place a Purchase's canonical name is decided.
//
// `<Gym name> - <Purchase label> - <creation date/time>`, e.g.
// `Gym Name - Compra - 23/11/2026 11:56`. Generated once, when the purchase is
// created (`createPurchase()`), and stored whole in `purchases.name`; the same
// string is then copied verbatim onto the purchase's checkout Billing Event
// (#3287, `stampEventPurchase()`) and sent as the provider payment's
// `description`. Nothing re-derives it on a read, and a later change of the
// gym's name, its Time & Localization or the viewer's language leaves it as it
// was.
//
// #3553: an Admin Save & Pay renames it once, from what it pays for, as it leaves the cart
// (`contentsPurchaseName()` below); nothing else ever does.
//
// Pure: the caller reads the gym and the request's locale.

import { formatGymDateTime, type GymLocalization } from './gymLocalization';

/** The label each language writes; a locale outside the list takes the fallback's. */
export const PURCHASE_NAME_LABELS: Readonly<Record<string, string>> = {
  en: 'Purchase',
  es: 'Compra',
  ca: 'Compra',
};

/** A request with no recognised locale, and every purchase created before #3288. */
export const PURCHASE_NAME_FALLBACK_LOCALE = 'en';

/** `purchases.name`'s width: a gym name (255) and the rest, never cut. */
export const PURCHASE_NAME_MAX_LENGTH = 320;

export function purchaseNameLabel(locale: string | null | undefined): string {
  const primary = String(locale ?? '').toLowerCase().split('-')[0];
  return PURCHASE_NAME_LABELS[primary] ?? PURCHASE_NAME_LABELS[PURCHASE_NAME_FALLBACK_LOCALE];
}

export function canonicalPurchaseName(input: {
  gymName: string | null | undefined;
  locale: string | null | undefined;
  createdAt: Date;
  settings: Pick<GymLocalization, 'time_zone' | 'date_format' | 'time_format'>;
}): string {
  const gym = String(input.gymName ?? '').trim();
  const rest = `${purchaseNameLabel(input.locale)} - ${formatGymDateTime(input.createdAt, input.settings)}`;
  return gym ? `${gym} - ${rest}` : rest;
}

// #3553 — an Admin Save & Pay names its purchase after what it pays for.

/** What a checkout holds, by name: what it adds (or edits), and what it cancels. */
export interface PurchaseContents {
  /** Membership Plans the cart adds or changes (never a plan carried over unchanged). */
  plans: string[];
  /** Standalone Products: recurring lines the cart adds, one-time lines it holds. A plan's included Products are not here. */
  products: string[];
  cancelledPlans: string[];
  cancelledProducts: string[];
}

const COUNT_WORDS: Readonly<Record<string, { product: [string, string]; plan: [string, string]; cancellation: string }>> = {
  en: { product: ['product', 'products'], plan: ['plan', 'plans'], cancellation: 'Cancellation' },
  es: { product: ['producto', 'productos'], plan: ['plan', 'planes'], cancellation: 'Cancelación' },
  ca: { product: ['producte', 'productes'], plan: ['pla', 'plans'], cancellation: 'Cancel·lació' },
};

function wordsFor(locale: string | null | undefined) {
  const primary = String(locale ?? '').toLowerCase().split('-')[0];
  return COUNT_WORDS[primary] ?? COUNT_WORDS[PURCHASE_NAME_FALLBACK_LOCALE];
}

function counted(n: number, forms: [string, string]): string {
  return `${n} ${n === 1 ? forms[0] : forms[1]}`;
}

/** The item part: one Product or one Plan by name, else `n products · m plans` (zero included). */
function itemPart(plans: string[], products: string[], locale: string | null | undefined): string {
  if (plans.length === 0 && products.length === 1) return products[0];
  if (products.length === 0 && plans.length === 1) return plans[0];
  const w = wordsFor(locale);
  return `${counted(products.length, w.product)} · ${counted(plans.length, w.plan)}`;
}

/**
 * The name of an Admin Save & Pay purchase, or `null` when its contents name nothing (it then keeps
 * the #3288 canonical name it was created with). A cart that adds anything is named after what it
 * adds; one that only cancels is named after what it cancels, with the `(Cancellation)` suffix.
 */
export function contentsPurchaseName(input: {
  gymName: string | null | undefined;
  locale: string | null | undefined;
  contents: PurchaseContents;
}): string | null {
  const { plans, products, cancelledPlans, cancelledProducts } = input.contents;
  let rest: string;
  if (plans.length + products.length > 0) {
    rest = itemPart(plans, products, input.locale);
  } else if (cancelledPlans.length + cancelledProducts.length > 0) {
    rest = `${itemPart(cancelledPlans, cancelledProducts, input.locale)} (${wordsFor(input.locale).cancellation})`;
  } else {
    return null;
  }
  const gym = String(input.gymName ?? '').trim();
  const name = gym ? `${gym} - ${rest}` : rest;
  return name.length > PURCHASE_NAME_MAX_LENGTH ? `${name.slice(0, PURCHASE_NAME_MAX_LENGTH - 1)}…` : name;
}
