// #942: what has to be said *beside* a Sellable Item's Price so the figure
// cannot be misread.
//
// Two different sentences, and they answer two different questions:
//
//   taxNoteKey()        — does this figure include tax? The list has said so
//                         since the column existed; the expanded card and the
//                         Details modal did not, and a bare `€50.00` beside a
//                         `21%` tax rate is exactly as ambiguous as the ticket
//                         says it is.
//   sessionPackageNote() — for a `sessions` item, the Price is the total for
//                         the whole package, not one session. `5` and `€50.00`
//                         sitting in adjacent columns read as €50.00 each and
//                         €250.00 the lot, which is the misreading #942 exists
//                         to remove.
//
// Both are **labels only**. Neither function sees a price, and nothing here
// multiplies, divides or re-derives one: the number every surface shows is the
// number it showed before this ticket (AC 1 and AC 8). `units` is read for its
// count alone.
//
// Declared once beside the page, per #805's rule that the inline create card
// and the inline editor render the same form body rather than two copies of
// it — here the same note also has to reach the collapsed row, the read-only
// expanded card and the Details modal, so five call sites share one rule
// rather than each spelling out `type === 'sessions'` for itself.

/**
 * `gym_charges.type` for a session package. Mirrors the page's own
 * `SESSION_TYPE`, which is the value `classifySellableItem()` (#550) maps to
 * the `session` benefit category.
 */
export const SESSION_ITEM_TYPE = 'sessions';

/**
 * Which `(tax …)` suffix belongs beside a displayed price, or `null` when none
 * does.
 *
 * `null` is the load-bearing answer: an item with no tax rate has no
 * `applied_tax_rate`, and annotating it `(tax included)` would claim a tax that
 * is not configured. That is also the condition the list already uses to decide
 * between `amount_incl_tax` and the raw amount, so the two surfaces agree about
 * when tax is part of the figure.
 */
export function taxNoteKey(item: {
  tax_behavior: 'inclusive' | 'exclusive';
  applied_tax_rate: number | null;
}): 'taxIncluded' | 'taxExcluded' | null {
  if (item.applied_tax_rate == null) return null;
  return item.tax_behavior === 'exclusive' ? 'taxExcluded' : 'taxIncluded';
}

/**
 * The clarification line under a session package's price.
 *
 * `price_total_for_sessions` carries the item's own `units` as `count` and
 * pluralises in ICU, so `1` reads *1 session* and `5` reads *5 sessions*
 * (AC 4, AC 5). `price_total_for_package` is the fallback for a session item
 * whose `units` is unset — the column is nullable and the form accepts an empty
 * value, and saying nothing there leaves precisely the ambiguity the ticket is
 * about.
 *
 * `null` for every other type, which is what keeps fee-based items untouched
 * (AC 7).
 */
export type SessionPackageNote =
  | { key: 'price_total_for_sessions'; count: number }
  | { key: 'price_total_for_package' };

export function sessionPackageNote(item: {
  type: string;
  units: number | null;
}): SessionPackageNote | null {
  if (item.type !== SESSION_ITEM_TYPE) return null;
  const { units } = item;
  if (units == null || !Number.isFinite(units) || units <= 0) {
    return { key: 'price_total_for_package' };
  }
  return { key: 'price_total_for_sessions', count: Math.trunc(units) };
}

/**
 * The same note for a form that is still being filled in, where `type` is the
 * select's live value and `units` an unparsed string.
 *
 * It tracks typing rather than the saved row, so switching Type to Sessions or
 * changing Units updates the sentence under the Price input immediately — the
 * person entering `50.00` is the one who most needs to know it buys the whole
 * package. A half-typed or invalid `units` falls through to the package wording
 * instead of rendering `NaN`.
 */
export function sessionPackageNoteForForm(form: {
  type: string;
  units: string;
}): SessionPackageNote | null {
  const trimmed = form.units.trim();
  const parsed = trimmed === '' ? null : Number(trimmed);
  return sessionPackageNote({
    type: form.type,
    units: parsed != null && Number.isFinite(parsed) ? parsed : null,
  });
}
