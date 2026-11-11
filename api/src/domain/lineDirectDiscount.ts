/**
 * #2490 stage 3 — a Membership Plan Product line's own **Direct Discount**.
 *
 * A percentage (0..100) beside the line's Benefit treatment (`action`/`value`,
 * #896/#1184), never a replacement for it: the treatment says how the Plan
 * prices the item, the Direct Discount takes a further percentage off what the
 * line ends up costing. It is applied **last**, after the treatment and after
 * every covering Promotion grant, which is the standalone Product purchase's
 * own order (`priceProductPurchase()`: list → Promotions → direct discount), and
 * it is one line's alone: it never touches another line or the Membership Fee
 * (whose own direct discount is the Personal Membership Fee Benefit, #772).
 *
 * Stored as `direct_discount_percent` on `membership_plan_{session,oneoff,periodical}`
 * and on the plan snapshot lines (`plan_*_snapshots`, migration 390), NULL
 * meaning none — what every line written before the migration reads as.
 *
 * The arithmetic is `applyPeriodBenefit()`'s `percentage_discount`, so no
 * second discount formula exists.
 */
import { applyPeriodBenefit } from './promotionBenefits';

export type LineDirectDiscountInput =
  | { keep: true; percent?: undefined; error?: undefined }
  | { keep: false; percent: number | null; error?: undefined }
  | { keep?: undefined; percent?: undefined; error: string };

/**
 * One submitted line's `direct_discount_percent`, with #896's three answers:
 * not mentioned keeps what is stored (the section `PUT`s are replace-all),
 * `null`/`''` clears it, a number 0..100 sets it, anything else is a 400 —
 * never a coercion. A 0 is stored as NULL, since it discounts nothing.
 */
export function parseLineDirectDiscountInput(item: unknown): LineDirectDiscountInput {
  if (item == null || typeof item !== 'object' || !('direct_discount_percent' in item)) return { keep: true };
  const raw = (item as { direct_discount_percent?: unknown }).direct_discount_percent;
  if (raw === undefined) return { keep: true };
  if (raw === null || raw === '') return { keep: false, percent: null };
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { error: 'direct_discount_percent must be a number between 0 and 100' };
  }
  return { keep: false, percent: n === 0 ? null : Math.round(n * 100) / 100 };
}

/** A stored value (mysql2 reads DECIMAL as a string) as a usable percentage, or null. */
export function toLineDirectDiscount(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(100, n);
}

/** What a line costs once its Direct Discount is taken off `amount` (already treated). */
export function applyLineDirectDiscount(amount: number, percent: number | null | undefined): number {
  if (percent == null || !(percent > 0)) return Math.round(amount * 100) / 100;
  return applyPeriodBenefit(amount, 'percentage_discount', Math.min(100, percent));
}
