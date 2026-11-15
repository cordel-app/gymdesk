// #2835 stage 1 — the Assigned Plan breakdown edited in place.
//
// Pressing a section's Edit no longer swaps its grid for a different form: the
// same rows stay in the same columns, the Direct Discount (%) cell becomes an
// input and an Optional line gains a ✕. What a section's draft *is* lives here
// so the grid and the payload cannot disagree: each entry pairs the row the
// grid draws with the row the section's replace-all `PUT` sends.
//
// Pure: no React, no `t()`, no request. Nothing is priced here — the Final
// Price and the totals are the server's, re-read after Save (CLAUDE.md: no
// business logic in the frontend).

import type { ProductBenefitRow } from '@/lib/benefitEditing';

export interface LineEntry<L = unknown> {
  /** The snapshot line the row belongs to (its thumbnail, its detail modal). */
  line: L;
  /** What the grid draws: the read-only row, with the draft's discount on it. */
  view: ProductBenefitRow;
  /** What the section's `PUT` sends for this row. */
  draft: ProductBenefitRow;
}

/**
 * Pairs each drawn row with its draft row. The two lists are produced from the
 * same lines by the same allocation (one row per member of an Individual
 * Product, one for a Shared one), so they line up one to one; a caller whose
 * lists do not is refused rather than silently mispaired.
 */
export function pairLineEntries<L>(
  views: { line: L; row: ProductBenefitRow }[],
  drafts: ProductBenefitRow[],
): LineEntry<L>[] {
  if (views.length !== drafts.length) {
    throw new Error(`pairLineEntries: ${views.length} rows drawn for ${drafts.length} draft rows`);
  }
  return views.map((v, i) => ({
    line: v.line,
    view: { ...v.row, direct_discount_percent: drafts[i].direct_discount_percent ?? null },
    draft: drafts[i],
  }));
}

/** Only an Optional line (its own Mandatory flag off, #1184) may be removed. */
export function canRemoveLine(row: Pick<ProductBenefitRow, 'mandatory'>): boolean {
  return row.mandatory === false;
}

/** The entry at `index` with its Direct Discount (%) set, on both halves. */
export function withEntryDiscount<L>(entries: LineEntry<L>[], index: number, value: string): LineEntry<L>[] {
  return entries.map((e, i) => (i === index
    ? {
      ...e,
      view: { ...e.view, direct_discount_percent: value },
      draft: { ...e.draft, direct_discount_percent: value },
    }
    : e));
}

/** The entries without the one at `index` — refused for a Mandatory line. */
export function withoutEntry<L>(entries: LineEntry<L>[], index: number): LineEntry<L>[] {
  const entry = entries[index];
  if (!entry || !canRemoveLine(entry.draft)) return entries;
  return entries.filter((_, i) => i !== index);
}

/**
 * Whether a typed Direct Discount (%) is one the server takes: empty (none) or
 * a number from 0 to 100. Mirrors `benefitConfigError()`'s percentage rule
 * (`api/src/domain/productBenefitActions.ts`), which stays the authority.
 */
export function isValidDiscountPercent(raw: string | number | null | undefined): boolean {
  if (raw == null || raw === '') return true;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

/**
 * The Membership Fee's Direct Discount is its Personal Membership Fee Benefit
 * (#772): a percentage on every cycle. Empty or 0 is no benefit; anything else
 * is `percentage_discount` at that value. `null` for a value the server would
 * refuse, so the page reports it instead of sending it.
 */
export function feeDiscountPayload(
  raw: string,
): { action: 'no_benefit' | 'percentage_discount'; value: number | null } | null {
  if (!isValidDiscountPercent(raw)) return null;
  const n = raw === '' ? 0 : Number(raw);
  return n > 0 ? { action: 'percentage_discount', value: n } : { action: 'no_benefit', value: null };
}

/** The fee's agreed benefit as the Direct Discount (%) cell reads it. */
export function feeDiscountValue(benefit: { action: string; value: number | null }): string {
  return benefit.action === 'percentage_discount' && benefit.value != null ? String(benefit.value) : '';
}
