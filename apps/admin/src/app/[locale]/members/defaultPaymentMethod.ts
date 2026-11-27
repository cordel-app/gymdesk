/**
 * #3497 — the Member's Default Payment Method as the Profile reads it. Pure:
 * which option is which, its label and whether a save needs the confirmation.
 * The rule of what may be stored, and its effect on later charges, is the API's
 * (`api/src/domain/memberDefaultPaymentMethod.ts`); this module decides neither.
 */

export const AUTOMATED_PAYMENT_METHOD = 'automated';

export interface DefaultPaymentMethodOption {
  code: string;
  /** The catalogue name in the request's locale; `null` for Automated, whose label is a locale key. */
  name: string | null;
  catalogue_code: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export interface DefaultPaymentMethodView {
  default_payment_method: string;
  is_explicit: boolean;
  options: DefaultPaymentMethodOption[];
}

/** The label of an option: the catalogue's name, or the Automated key resolved by the caller. */
export function defaultPaymentMethodLabel(
  code: string,
  options: readonly DefaultPaymentMethodOption[],
  automatedLabel: string,
): string {
  if (code === AUTOMATED_PAYMENT_METHOD) return automatedLabel;
  return options.find((o) => o.code === code)?.name ?? code;
}

export function optionFor(code: string, options: readonly DefaultPaymentMethodOption[]): DefaultPaymentMethodOption | null {
  return options.find((o) => o.code === code) ?? null;
}

/**
 * Whether Save must first confirm a change: the selection differs from the
 * persisted method (as the server reported it), never from what the dropdown
 * happened to show before.
 */
export function needsDefaultPaymentMethodConfirmation(persisted: string | null, selected: string | null): boolean {
  if (persisted == null || selected == null) return false;
  return persisted !== selected;
}
