// #821: the Billing Frequency choices a Sellable Item form offers, mirrored
// from `api/src/domain/sellableItemFrequency.ts` — the API is what enforces
// them (a frontend-only list is not a rule), this file is what the two halves
// of the page render.
//
// Declared once beside the page, per #805's rule that the inline create card
// and the inline editor render the same form body rather than two copies of it:
// both selects are built from `frequencyOptions()` and neither may spell the
// list out itself.
//
// `week` is not offered any more, but it is still **stored** by items
// configured before the ticket. Those keep working: the option is rendered —
// disabled, so it cannot be picked — only while it is the value the form
// currently holds, which is how an existing weekly item shows its real
// frequency, submits it back unchanged, and disappears from the list the moment
// the user chooses something else.

export const OFFERED_FREQUENCIES = ['once', 'per_session', 'four_weeks', 'month', 'year'] as const;
export const LEGACY_FREQUENCIES = ['week'] as const;

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
 * five offered ones always, plus the item's own legacy frequency when it has
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
