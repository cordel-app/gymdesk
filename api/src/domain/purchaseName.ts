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
