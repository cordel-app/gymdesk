// #486: Pay Beforehand and Improve Promotion Forecast — computes the Promotion
// Example Timeline/Forecast server-side so the classification logic (which
// billing period is Free/Pay/Prepaid/Bonus/Regular) lives in one place rather
// than being duplicated in the frontend. Purely a projection — never persisted.

export type PromotionTimelineStatus =
  | 'free_promotion'
  | 'pay_promotion'
  | 'prepaid_promotion'
  | 'bonus_promotion'
  | 'pay_regular';

export interface PromotionTimelineConfig {
  freeMonths: number;
  paidMonths: number;
  payBeforehandMonths: number;
  bonusMonths: number;
}

export interface PromotionTimelinePeriod {
  period: number;
  status: PromotionTimelineStatus;
  startsOn: string; // YYYY-MM-DD
  endsOn: string | null; // null for the final, open-ended regular period
}

export interface PromotionTimelineResult {
  periods: PromotionTimelinePeriod[];
}

/**
 * `pay_beforehand_months` must be between 0 and `paid_months` (inclusive) —
 * it selects how many of the paid promotional months are already prepaid.
 */
export function validatePayBeforehandMonths(paidMonths: number, payBeforehandMonths: number): string | null {
  if (!Number.isFinite(payBeforehandMonths) || payBeforehandMonths < 0) {
    return 'pay_beforehand_months must be >= 0';
  }
  if (payBeforehandMonths > paidMonths) {
    return 'pay_beforehand_months cannot exceed paid_months';
  }
  return null;
}

function addMonthsToDateStr(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}

function dayBefore(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * Projects the complete promotional lifecycle plus one additional regular
 * billing period: Free (promotion) → Prepaid/Pay (promotion) → Bonus
 * (promotion) → Pay (regular). `anchorDate` defaults to the first of the
 * current month (UTC) — a hypothetical enrollment date for illustration.
 */
export function computePromotionTimeline(config: PromotionTimelineConfig, anchorDate?: string): PromotionTimelineResult {
  const free = Math.max(0, Math.trunc(config.freeMonths) || 0);
  const paid = Math.max(0, Math.trunc(config.paidMonths) || 0);
  const prepaid = Math.max(0, Math.min(Math.trunc(config.payBeforehandMonths) || 0, paid));
  const bonus = Math.max(0, Math.trunc(config.bonusMonths) || 0);

  const anchor = anchorDate ?? new Date().toISOString().slice(0, 10);
  const [ay, am] = anchor.split('-').map(Number);
  let cursor = `${ay}-${String(am).padStart(2, '0')}-01`;

  const periods: PromotionTimelinePeriod[] = [];
  let period = 1;
  const pushPeriod = (status: PromotionTimelineStatus, openEnded = false) => {
    const startsOn = cursor;
    const next = addMonthsToDateStr(cursor, 1);
    periods.push({ period, status, startsOn, endsOn: openEnded ? null : dayBefore(next) });
    cursor = next;
    period++;
  };

  for (let i = 0; i < free; i++) pushPeriod('free_promotion');
  for (let i = 0; i < paid; i++) pushPeriod(i < prepaid ? 'prepaid_promotion' : 'pay_promotion');
  for (let i = 0; i < bonus; i++) pushPeriod('bonus_promotion');
  pushPeriod('pay_regular', true);

  return { periods };
}
