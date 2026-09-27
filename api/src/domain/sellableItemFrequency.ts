// #821: a Sellable Item's **Billing Frequency** is one of five choices.
//
// `gym_charges.billing_frequency` has carried six values since migration 123
// (`once`, `per_session`, `four_weeks`, `week`, `month`, `year`). `week` is the
// one nobody sells — a weekly locker rental or a weekly fee is not something
// the product offers — so #821 removes it from the *product* surface while
// leaving every stored row exactly as it is.
//
// That split is the whole point of this module, and it is the same shape #820
// gave a Membership Plan's cadence:
//
//   OFFERED — what a Sellable Item may be *configured* with, in the order the
//             dropdown lists them. `POST /sellable-items` accepts only these.
//   LEGACY  — stored, read, classified (`isRecurringFrequency()`), displayed
//             and billed exactly as before, but never selectable. `week` is
//             the only member, and a `PUT` may carry it through **unchanged**
//             so that editing another field of a legacy item neither 400s nor
//             quietly rewrites its frequency (§"handled safely so that their
//             existing data is not silently corrupted or changed").
//
// No migration: `gym_charges_billing_frequency_check` (migration 123) keeps
// permitting all six, because the rows that hold `week` must stay valid and
// the route — not the CHECK — is what refuses a new one. There is deliberately
// no backfill and no coercion to `month`/`four_weeks`: a weekly item is a real
// price a gym agreed, and the two are not the same period.

/** What a Sellable Item may be configured with, in dropdown order. */
export const OFFERED_SELLABLE_ITEM_FREQUENCIES = [
  'once',
  'per_session',
  'four_weeks',
  'month',
  'year',
] as const;

/** Stored by rows written before #821; readable and billable, never selectable. */
export const LEGACY_SELLABLE_ITEM_FREQUENCIES = ['week'] as const;

export type OfferedSellableItemFrequency = (typeof OFFERED_SELLABLE_ITEM_FREQUENCIES)[number];
export type LegacySellableItemFrequency = (typeof LEGACY_SELLABLE_ITEM_FREQUENCIES)[number];
export type SellableItemFrequency = OfferedSellableItemFrequency | LegacySellableItemFrequency;

/** Everything the column may hold — what the CHECK permits and reads answer with. */
export const STORED_SELLABLE_ITEM_FREQUENCIES: readonly SellableItemFrequency[] = [
  ...OFFERED_SELLABLE_ITEM_FREQUENCIES,
  ...LEGACY_SELLABLE_ITEM_FREQUENCIES,
];

export function isOfferedSellableItemFrequency(value: unknown): value is OfferedSellableItemFrequency {
  return typeof value === 'string'
    && (OFFERED_SELLABLE_ITEM_FREQUENCIES as readonly string[]).includes(value);
}

export function isLegacySellableItemFrequency(value: unknown): value is LegacySellableItemFrequency {
  return typeof value === 'string'
    && (LEGACY_SELLABLE_ITEM_FREQUENCIES as readonly string[]).includes(value);
}

/** Whether a stored value is one this codebase knows (offered or legacy). */
export function isStoredSellableItemFrequency(value: unknown): value is SellableItemFrequency {
  return isOfferedSellableItemFrequency(value) || isLegacySellableItemFrequency(value);
}

/** `once, per_session, four_weeks, month, year` — for the routes' 400 message. */
export function describeOfferedFrequencies(): string {
  return OFFERED_SELLABLE_ITEM_FREQUENCIES.join(', ');
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
 * how an existing weekly item stays editable — its form submits `week` back
 * untouched — while a new one can never be created and an item on another
 * frequency can never be moved onto it.
 */
export function sellableItemFrequencyWriteError(next: unknown, current: unknown): string | null {
  if (next === undefined || next === null || next === '') return null;
  if (isOfferedSellableItemFrequency(next)) return null;
  if (isLegacySellableItemFrequency(next) && next === current) return null;
  if (isLegacySellableItemFrequency(next)) {
    return `billing_frequency '${next}' is no longer offered and can only be kept on an item that already stores it; `
      + `choose one of: ${describeOfferedFrequencies()}`;
  }
  return `billing_frequency must be one of: ${describeOfferedFrequencies()}`;
}
