/**
 * #3497 — a Member's Default Payment Method: the one place its vocabulary and
 * its write rule live. Pure; the I/O half is `api/member-default-payment-method.ts`.
 *
 * `members.default_payment_method` (migration 497) holds the preference and
 * nothing else: NULL means no explicit preference, which reads as **Automated**
 * through `resolveDefaultPaymentMethod()` (#3512's resolver, unchanged). It is a
 * member setting — never a Billing Event's: no event row, attempt or snapshot
 * stores or copies it, and an attempt resolves it when the attempt is created.
 *
 * The options are the ways a later charge can be taken:
 *   - `automated`    the nightly run charges the payer's stored MONEI token
 *                    (shown with the `monei` catalogue entry's name and image)
 *   - `members_app`  the member pays through a payment link
 *   - `cash`         front-desk cash
 *   - `card`         an external card terminal
 * Each non-automated option names its `base_payment_methods.code`. A token is
 * never a precondition: Automated is always offered and always saveable.
 */

import { AUTOMATED_PAYMENT_METHOD, resolveDefaultPaymentMethod } from './paymentGatewayRegistration';

export { AUTOMATED_PAYMENT_METHOD, resolveDefaultPaymentMethod };

export const DEFAULT_PAYMENT_METHOD_OPTIONS = [AUTOMATED_PAYMENT_METHOD, 'members_app', 'cash', 'card'] as const;
export type DefaultPaymentMethod = (typeof DEFAULT_PAYMENT_METHOD_OPTIONS)[number];

/** The catalogue entry whose name and image an option is drawn with. */
export function catalogueCodeForOption(option: string): string {
  return option === AUTOMATED_PAYMENT_METHOD ? 'monei' : option;
}

export function isDefaultPaymentMethodOption(value: unknown): value is DefaultPaymentMethod {
  return typeof value === 'string' && (DEFAULT_PAYMENT_METHOD_OPTIONS as readonly string[]).includes(value);
}

/**
 * Which options a member is offered: Automated always (its catalogue entry being
 * inactive does not hide it), every other option while its catalogue method is
 * active, and the member's stored value whatever its state, so an editor never
 * silently reads it as another one.
 */
export function offeredDefaultPaymentMethods(activeCatalogueCodes: Iterable<string>, stored: string | null | undefined): DefaultPaymentMethod[] {
  const active = new Set(activeCatalogueCodes);
  const current = resolveDefaultPaymentMethod(stored);
  return DEFAULT_PAYMENT_METHOD_OPTIONS.filter((o) =>
    o === AUTOMATED_PAYMENT_METHOD || active.has(catalogueCodeForOption(o)) || o === current);
}

/**
 * Judges a request's `default_payment_method`. `null` or `''` resets to no
 * preference (Automated); an option of the declared set is accepted when it is
 * offered; anything else is a 400, never a coercion.
 */
export function parseDefaultPaymentMethodInput(raw: unknown, offered: readonly string[]):
  { value: DefaultPaymentMethod | null } | { error: string } {
  if (raw === null || raw === '') return { value: null };
  if (!isDefaultPaymentMethodOption(raw)) {
    return { error: `default_payment_method must be one of: ${DEFAULT_PAYMENT_METHOD_OPTIONS.join(', ')}` };
  }
  if (!offered.includes(raw)) return { error: `default_payment_method '${raw}' is not available` };
  return { value: raw };
}

/** Whether the nightly run may charge this payer's stored token automatically. */
export function chargesAutomatically(stored: string | null | undefined): boolean {
  return resolveDefaultPaymentMethod(stored) === AUTOMATED_PAYMENT_METHOD;
}

/** Whether changing from `previous` to `next` is a change at all (NULL reads as Automated). */
export function defaultPaymentMethodChanged(previous: string | null | undefined, next: string | null | undefined): boolean {
  return resolveDefaultPaymentMethod(previous) !== resolveDefaultPaymentMethod(next);
}
