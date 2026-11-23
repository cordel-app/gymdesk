/**
 * #3254 — the label key a Billing Event Line's `source` reads under (`billing_events_page.*`).
 * Decided before `t()` is called, since next-intl prints a missing key verbatim: a line with no
 * source (an adjustment, a historical line whose origin was not determinable) reads `—`.
 */
export type BillingEventLineSource = 'plan' | 'product';

export function lineSourceLabelKey(source: string | null | undefined): 'line_source_plan' | 'line_source_product' | null {
  if (source === 'plan') return 'line_source_plan';
  if (source === 'product') return 'line_source_product';
  return null;
}
