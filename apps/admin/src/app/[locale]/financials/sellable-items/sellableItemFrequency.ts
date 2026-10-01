// #821 / #945: the Billing Frequency choices a Sellable Item form offers,
// mirrored from `api/src/domain/sellableItemFrequency.ts` — the API is what
// enforces them (a frontend-only list is not a rule), this file is what the two
// halves of the page render.
//
// Declared once beside the page, per #805's rule that the inline create card
// and the inline editor render the same form body rather than two copies of it:
// both selects are built from `frequencyOptions()` and neither may spell the
// list out itself.
//
// `week` (#821) and `per_session` (#945) are not offered any more, but they are
// still **stored** by items configured before those tickets. Those keep
// working: the option is rendered — disabled, so it cannot be picked — only
// while it is the value the form currently holds, which is how an existing
// item shows its real frequency, submits it back unchanged, and disappears
// from the list the moment the user chooses something else. The notice beside
// the select names the value it holds, which is #945 §3's "flag the value for
// correction rather than guessing".
export const OFFERED_FREQUENCIES = ['once', 'four_weeks', 'month', 'year'] as const;
export const LEGACY_FREQUENCIES = ['per_session', 'week'] as const;

export type OfferedFrequency = typeof OFFERED_FREQUENCIES[number];
export type LegacyFrequency = typeof LEGACY_FREQUENCIES[number];
export type Frequency = OfferedFrequency | LegacyFrequency;

export function isLegacyFrequency(value: unknown): value is LegacyFrequency {
  return typeof value === 'string' && (LEGACY_FREQUENCIES as readonly string[]).includes(value);
}

export interface FrequencyOption {
  value: Frequency;
  /** Key in the `sellable_items` namespace. */
  labelKey: string;
  /** A legacy frequency is shown (so the row reads truthfully) but not selectable. */
  disabled: boolean;
}

/**
 * The options a select should render given the value it currently holds. The
 * four offered ones always, plus the item's own legacy frequency when it has
 * one — never any other legacy value, so the list can only ever shrink.
 */
export function frequencyOptions(current: string | null | undefined): FrequencyOption[] {
  const options: FrequencyOption[] = OFFERED_FREQUENCIES.map((f) => ({
    value: f,
    labelKey: `frequency_${f}`,
    disabled: false,
  }));
  if (isLegacyFrequency(current)) {
    options.push({ value: current, labelKey: `frequency_${current}`, disabled: true });
  }
  return options;
}

/**
 * The label key for a legacy value the form holds, for the notice beside the
 * select — resolved before `t()` is called, never through a `defaultValue`
 * option (next-intl has none and would print the key).
 */
export function legacyFrequencyLabelKey(current: string | null | undefined): string | null {
  return isLegacyFrequency(current) ? `frequency_${current}` : null;
}
