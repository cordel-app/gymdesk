// #2093 stage 3 — the Billing & Duration save (#2490: the Direct Discount lives on the Membership Fee Benefit), as pure
// functions: every field is validated before any request is sent, so a bad
// value can never leave an assignment half saved (#2092). The Assigned Plan
// editor builds its payload here; the requests stay the card's.

export type DurationFormValues = {
  free_periods: string;
  paid_periods: string;
  pay_beforehand_periods: string;
  bonus_periods: string;
  recurring_billing_interval: string;
  recurring_billing_unit: string;
};

export type DurationFormError = 'duration_invalid';

const COUNT_FIELDS = [
  'free_periods', 'paid_periods', 'pay_beforehand_periods', 'bonus_periods', 'recurring_billing_interval',
] as const;

function toNullableNumber(raw: string): number | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/** The first problem with the form, or null when every field may be sent. */
export function durationFormError(form: DurationFormValues): DurationFormError | null {
  for (const field of COUNT_FIELDS) {
    const n = toNullableNumber(form[field]);
    if (n !== null && (!Number.isInteger(n) || n < 0)) return 'duration_invalid';
  }
  return null;
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
