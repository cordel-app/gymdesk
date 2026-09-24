// #485: Billing Events Forecast — a read-only, non-persisted projection of a
// Membership Plan's upcoming billing events, derived from its current price,
// billing frequency, and Plan Charge Benefits. Intentionally excludes
// promotions (see ticket #485, sections 12-13, 20).
import { advanceBillingDate } from './billingDate';

export type BillingUnit = 'day' | 'week' | 'month' | 'year';
export type ChargeBenefitAction = 'no_benefit' | 'waive' | 'percentage_discount' | 'fixed_discount';

export interface ForecastBenefitLine {
  label: string;
  amount: number | null;
  action: ChargeBenefitAction;
  value: number | null;
}

export interface ForecastLineItem {
  label: string;
  amount: number;
  benefit?: { action: 'waive' | 'percentage_discount' | 'fixed_discount'; value: number | null };
}

export interface ForecastEvent {
  date: string;
  description: string;
  total: number;
  lines: ForecastLineItem[];
}

export interface BillingForecastInput {
  planName: string;
  price: number | null;
  recurringBillingInterval: number | null;
  recurringBillingUnit: BillingUnit | null;
  benefitLines: ForecastBenefitLine[];
  anchorDate?: string; // YYYY-MM-DD; defaults to today (UTC)
  count?: number; // defaults to 10
}

export interface BillingForecastResult {
  available: boolean;
  reason: string | null;
  events: ForecastEvent[];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthYearLabel(dateStr: string): string {
  const [year, month] = dateStr.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Applies a single Plan Charge Benefit action to one charge amount. Clamped at 0 — never negative. */
export function applyChargeBenefit(amount: number, action: ChargeBenefitAction, value: number | null): number {
  let result = amount;
  if (action === 'waive') result = 0;
  else if (action === 'percentage_discount') result -= result * ((value ?? 0) / 100);
  else if (action === 'fixed_discount') result -= value ?? 0;
  if (result < 0) result = 0;
  return round2(result);
}

/**
 * Projects the next `count` billing events for a Plan from its current price,
 * billing frequency, and charge benefits. Does not persist anything and does
 * not apply Promotions — see ticket #485.
 */
export function computeBillingForecast(input: BillingForecastInput): BillingForecastResult {
  const { planName, price, recurringBillingInterval, recurringBillingUnit, benefitLines } = input;
  const count = input.count ?? 10;

  if (price == null || recurringBillingInterval == null || recurringBillingUnit == null) {
    return {
      available: false,
      reason: 'Configure a price and billing frequency to preview upcoming billing events.',
      events: [],
    };
  }

  const anchor = input.anchorDate ?? new Date().toISOString().slice(0, 10);
  const events: ForecastEvent[] = [];
  let cursor = anchor;
  for (let i = 0; i < count; i++) {
    cursor = advanceBillingDate(cursor, recurringBillingInterval, recurringBillingUnit);

    const lines: ForecastLineItem[] = [{ label: planName, amount: round2(price) }];
    for (const bl of benefitLines) {
      if (bl.action === 'no_benefit') continue;
      const base = bl.amount ?? 0;
      lines.push({
        label: bl.label,
        amount: applyChargeBenefit(base, bl.action, bl.value),
        benefit: { action: bl.action, value: bl.value },
      });
    }

    events.push({
      date: cursor,
      description: `${monthYearLabel(cursor)} Membership Fee`,
      total: round2(lines.reduce((sum, l) => sum + l.amount, 0)),
      lines,
    });
  }

  return { available: true, reason: null, events };
}
