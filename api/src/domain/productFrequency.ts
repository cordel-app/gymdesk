// #821 / #945: a Product's **Billing Frequency** is one of four choices.
//
// `gym_charges.billing_frequency` has carried six values since migration 123
// (`once`, `per_session`, `four_weeks`, `week`, `month`, `year`). Two of them
// are not things the product sells:
//
//   `week`        — #821. A weekly locker rental or a weekly fee is not
//                   something the product offers.
//   `per_session` — #945. A session package's size is its **Units** and its
//                   Billing Frequency is when the whole package is billed
//                   (`10 units / €500 / Once` = €500 for the ten). "Per
//                   Session" implies usage-based billing, which the Product
//                   Item model does not have: `cadenceForProduct()`
//                   already gives it no schedule, so it has always billed
//                   exactly like `once`.
//
// Both leave the *product* surface while every stored row stays exactly as it
// is, and that split is the whole point of this module — the same shape #820
// gave a Membership Plan's cadence:
//
//   OFFERED — what a Product may be *configured* with, in the order the
//             dropdown lists them. `POST /sellable-items` accepts only these.
//   LEGACY  — stored, read, classified (`isRecurringFrequency()`), displayed
//             and billed exactly as before, but never selectable. A `PUT` may
//             carry one through **unchanged** so that editing another field of
//             a legacy item neither 400s nor quietly rewrites its frequency
//             (#945 §3, #821 §"handled safely so that their existing data is
//             not silently corrupted or changed").
//
// No migration: `gym_charges_billing_frequency_check` (migration 123) keeps
// permitting all six, because the rows that hold a legacy value must stay valid
// and the route — not the CHECK — is what refuses a new one. There is
// deliberately no backfill and no coercion:
//
//   * a weekly item is a real price a gym agreed, and `week` is neither a month
//     nor 28 days;
//   * `per_session` bills like `once` today, but what a gym *meant* by it is
//     not knowable from the row — a 10-session package billed once, or a
//     usage-based model the product never had — so #945 §3's second sentence
//     applies: flag the value for correction rather than guessing. The editor
//     renders it disabled with `frequency_legacy_notice` beside it, which is
//     that flag, and correcting it never moves the item between benefit
//     sections (`classifyProduct()` counts both `once` and `per_session`
//     as non-recurring).

/** What a Product may be configured with, in dropdown order. */
export const OFFERED_PRODUCT_FREQUENCIES = [
  'once',
  'four_weeks',
  'month',
  'year',
] as const;

/**
 * Stored by rows written before the ticket that retired them; readable and
 * billable, never selectable. `week` left with #821, `per_session` with #945.
 */
export const LEGACY_PRODUCT_FREQUENCIES = ['per_session', 'week'] as const;

export type OfferedProductFrequency = (typeof OFFERED_PRODUCT_FREQUENCIES)[number];
export type LegacyProductFrequency = (typeof LEGACY_PRODUCT_FREQUENCIES)[number];
export type ProductFrequency = OfferedProductFrequency | LegacyProductFrequency;

/** Everything the column may hold — what the CHECK permits and reads answer with. */
export const STORED_PRODUCT_FREQUENCIES: readonly ProductFrequency[] = [
  ...OFFERED_PRODUCT_FREQUENCIES,
  ...LEGACY_PRODUCT_FREQUENCIES,
];

export function isOfferedProductFrequency(value: unknown): value is OfferedProductFrequency {
  return typeof value === 'string'
    && (OFFERED_PRODUCT_FREQUENCIES as readonly string[]).includes(value);
}

export function isLegacyProductFrequency(value: unknown): value is LegacyProductFrequency {
  return typeof value === 'string'
    && (LEGACY_PRODUCT_FREQUENCIES as readonly string[]).includes(value);
}

/** Whether a stored value is one this codebase knows (offered or legacy). */
export function isStoredProductFrequency(value: unknown): value is ProductFrequency {
  return isOfferedProductFrequency(value) || isLegacyProductFrequency(value);
}

/** `once, four_weeks, month, year` — for the routes' 400 message. */
export function describeOfferedFrequencies(): string {
  return OFFERED_PRODUCT_FREQUENCIES.join(', ');
}

/**
 * The one rule for "may this write store this frequency?".
 *
 * `next` is what the request asks for (an absent/empty value clears the
 * column, which is allowed — the dropdown's `—` placeholder), and `current` is
 * what the row stores today (`null` on create). Returns the 400 message, or
 * `null` when the write may proceed.
 *
 * A legacy value passes only when it is what the row already holds: that is
 * how an existing weekly or per-session item stays editable — its form submits
 * the stored value back untouched — while a new one can never be created and
 * an item on another frequency can never be moved onto it.
 */
export function productFrequencyWriteError(next: unknown, current: unknown): string | null {
  if (next === undefined || next === null || next === '') return null;
  if (isOfferedProductFrequency(next)) return null;
  if (isLegacyProductFrequency(next) && next === current) return null;
  if (isLegacyProductFrequency(next)) {
    return `billing_frequency '${next}' is no longer offered and can only be kept on an item that already stores it; `
      + `choose one of: ${describeOfferedFrequencies()}`;
  }
  return `billing_frequency must be one of: ${describeOfferedFrequencies()}`;
}
