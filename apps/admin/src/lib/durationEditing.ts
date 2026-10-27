// #2093 stage 3 — the Billing & Duration + Direct Discount save, as pure
// functions: every field is validated before any request is sent, so a bad
// value can never leave an assignment half saved (#2092). The Assigned Plan
// editor builds its two payloads here; the requests stay the card's.

export type DurationFormValues = {
  free_periods: string;
  paid_periods: string;
  pay_beforehand_periods: string;
  bonus_periods: string;
  recurring_billing_interval: string;
  recurring_billing_unit: string;
  direct_discount_percent: string;
};

export type DurationFormError = 'direct_discount_invalid' | 'duration_invalid';

const COUNT_FIELDS = [
  'free_periods', 'paid_periods', 'pay_beforehand_periods', 'bonus_periods', 'recurring_billing_interval',
] as const;

function toNullableNumber(raw: string): number | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/** The first problem with the form, or null when every field may be sent. */
export function durationFormError(form: DurationFormValues): DurationFormError | null {
  const pct = directDiscountPercent(form);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return 'direct_discount_invalid';
  for (const field of COUNT_FIELDS) {
    const n = toNullableNumber(form[field]);
    if (n !== null && (!Number.isInteger(n) || n < 0)) return 'duration_invalid';
  }
  return null;
}

export function directDiscountPercent(form: Pick<DurationFormValues, 'direct_discount_percent'>): number {
  const n = toNullableNumber(form.direct_discount_percent);
  return n === null ? 0 : n;
}

/** Every field is sent, blank included: blank means "not configured" (NULL). */
export function billingDurationPayload(form: DurationFormValues) {
  return {
    free_periods: toNullableNumber(form.free_periods),
    paid_periods: toNullableNumber(form.paid_periods),
    pay_beforehand_periods: toNullableNumber(form.pay_beforehand_periods),
    bonus_periods: toNullableNumber(form.bonus_periods),
    recurring_billing_interval: toNullableNumber(form.recurring_billing_interval),
    recurring_billing_unit: form.recurring_billing_unit || null,
  };
}

/** 0 or blank is no benefit (#1925); a percentage is the Personal Membership Fee Benefit. */
export function directDiscountPayload(form: Pick<DurationFormValues, 'direct_discount_percent'>) {
  const pct = directDiscountPercent(form);
  return pct > 0 ? { action: 'percentage_discount', value: pct } : { action: 'no_benefit', value: null };
}
