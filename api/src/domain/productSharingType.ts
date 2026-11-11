/**
 * #2662: a Product's `sharing_type` (#2393) reads **Family** on screen; the
 * stored value stays `'shared'`, so nothing that already acts on it (#2609's
 * assignee rule, #2609 stage 3's per-unit distribution) moves.
 *
 * A Product linked to one or more Professional Services is always Family, and
 * this module is the one place that decides it for a write: what the row's
 * `sharing_type` becomes given what the request asked for and how many
 * Professional Services the Product will be linked to once the write commits.
 * Unlinking never changes it back (§2.6) — that is simply the absence of a
 * rule when `linkedServiceCount` is 0.
 */
import { PRODUCT_SHARING_TYPES } from './baseProducts';

export type ProductSharingTypeValue = (typeof PRODUCT_SHARING_TYPES)[number];

/** The stored value the UI calls Family. */
export const FAMILY_SHARING_TYPE: ProductSharingTypeValue = 'shared';

export type SharingTypeDecision =
  | { ok: true; value: ProductSharingTypeValue | null }
  | { ok: false; error: string; code: 'sharing_type_family_required' };

/**
 * `requested` is the request's value (absent/null keeps what is stored);
 * `value: null` means "leave the column alone". An explicit `individual` on a
 * Product that keeps a link is refused, never coerced, so a direct API request
 * cannot bypass the rule and is told why.
 */
export function decideProductSharingType(input: {
  requested: string | null | undefined;
  linkedServiceCount: number;
}): SharingTypeDecision {
  const requested = input.requested ?? null;
  if (input.linkedServiceCount > 0) {
    if (requested === 'individual') {
      return {
        ok: false,
        code: 'sharing_type_family_required',
        error: 'A product linked to a professional service must have sharing type Family (shared)',
      };
    }
    return { ok: true, value: FAMILY_SHARING_TYPE };
  }
  return { ok: true, value: (requested as ProductSharingTypeValue | null) };
}
