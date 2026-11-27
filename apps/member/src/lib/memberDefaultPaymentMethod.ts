/**
 * #3503 — the member's Default Payment Method as the Profile shows it.
 *
 * Pure, no React and no `t()`: what the method *is* is the API's
 * (`GET /me/default-payment-method`, which resolves it exactly as the staff
 * Profile does, #3497); this module only says which label to show, which
 * picture to draw and whether there is anything to draw at all. The Profile is
 * read-only here — nothing in the Members App writes the preference.
 */

export const DEFAULT_PAYMENT_METHOD_PATH = '/me/default-payment-method';
export const AUTOMATED_PAYMENT_METHOD = 'automated';

export interface MemberDefaultPaymentMethodMethod {
  code: string;
  /** The catalogue name in the request's locale; `null` for Automated, worded by a locale key. */
  name: string | null;
  description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
}

export interface MemberDefaultPaymentMethod {
  default_payment_method: string | null;
  is_explicit: boolean;
  method: MemberDefaultPaymentMethodMethod | null;
}

export type DefaultPaymentMethodDisplay =
  | { kind: 'empty' }
  | { kind: 'method'; label: string; thumbnail: string | null; image: string | null; description: string | null };

/**
 * What the Profile draws: the method's own name (Automated's resolved by the
 * caller from its locale key), its catalogue thumbnail for the row and its full
 * image for the preview, or the empty state when the API names no method.
 */
export function defaultPaymentMethodDisplay(
  view: MemberDefaultPaymentMethod | null | undefined,
  automatedLabel: string,
): DefaultPaymentMethodDisplay {
  const method = view?.method;
  if (!view?.default_payment_method || !method) return { kind: 'empty' };
  const label = method.code === AUTOMATED_PAYMENT_METHOD ? automatedLabel : (method.name || method.code);
  return {
    kind: 'method',
    label,
    thumbnail: method.image_thumbnail_url ?? method.image_url ?? null,
    image: method.image_url ?? method.image_thumbnail_url ?? null,
    description: method.description ?? null,
  };
}
