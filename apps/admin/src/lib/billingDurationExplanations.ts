// #2470 — the one place that decides which explanation each Billing & Duration
// parameter gets, and under which locale key. Pure: no React, no `t()`. The
// shared `BillingDurationExplanations` component resolves the keys from the one
// `billing_duration_help` namespace, so Plans, Assigned Plans and the Members
// card cannot word a parameter differently.
//
// It explains the configured values and decides no billing: the rules it words
// (month = first of the month, 4 weeks = a fixed 28-day cycle, ...) are the
// billing engine's own and are only described here.

export const BILLING_DURATION_HELP_NAMESPACE = 'billing_duration_help';

export interface BillingDurationConfig {
  free_periods: number | null | undefined;
  paid_periods: number | null | undefined;
  pay_beforehand_periods: number | null | undefined;
  bonus_periods: number | null | undefined;
  recurring_billing_interval: number | null | undefined;
  recurring_billing_unit: string | null | undefined;
  /** `undefined` when the host does not know the flag (an assignment's summary). */
  auto_renew?: boolean | null;
}

export interface BillingDurationExplanation {
  /** React list key — the parameter, never the translated text. */
  key: string;
  /** Key inside `billing_duration_help` for the parameter's name. */
  labelKey: string;
  /** Key inside `billing_duration_help` for the sentence. */
  textKey: string;
  values?: Record<string, number>;
}

const positive = (n: number | null | undefined): n is number => typeof n === 'number' && n > 0;

/** Which billing-alignment rule a stored cadence follows, or `null` for one with no rule. */
export function cadenceAlignmentKey(
  interval: number | null | undefined,
  unit: string | null | undefined,
): 'month' | 'four_weeks' | 'week' | 'year' | null {
  if (interval == null || !unit) return null;
  if (unit === 'month' && interval === 1) return 'month';
  if (unit === 'week' && interval === 4) return 'four_weeks';
  if (unit === 'week' && interval === 1) return 'week';
  if (unit === 'year' && interval === 1) return 'year';
  return null;
}

/**
 * The explanations to show, in the summary's own order. Only a parameter that
 * is configured (or, for Billing frequency and Auto-renew, known) is explained,
 * so an unconfigured Free Period never gets a sentence about a period that
 * does not exist.
 */
export function billingDurationExplanations(c: BillingDurationConfig): BillingDurationExplanation[] {
  const out: BillingDurationExplanation[] = [];
  if (positive(c.free_periods)) {
    out.push({ key: 'free_periods', labelKey: 'label_free', textKey: 'free', values: { count: c.free_periods } });
  }
  if (positive(c.paid_periods)) {
    out.push({ key: 'paid_periods', labelKey: 'label_paid', textKey: 'paid', values: { count: c.paid_periods } });
  }
  if (positive(c.pay_beforehand_periods)) {
    out.push({
      key: 'pay_beforehand_periods', labelKey: 'label_prepaid', textKey: 'prepaid',
      values: { count: c.pay_beforehand_periods },
    });
  }
  if (positive(c.bonus_periods)) {
    out.push({ key: 'bonus_periods', labelKey: 'label_bonus', textKey: 'bonus', values: { count: c.bonus_periods } });
  }
  if (c.recurring_billing_interval != null && c.recurring_billing_unit) {
    const rule = cadenceAlignmentKey(c.recurring_billing_interval, c.recurring_billing_unit);
    out.push({
      key: 'billing_frequency',
      labelKey: 'label_frequency',
      textKey: rule ? `alignment_${rule}` : 'alignment_other',
    });
  }
  if (c.auto_renew != null) {
    out.push({
      key: 'auto_renew', labelKey: 'label_auto_renew', textKey: c.auto_renew ? 'auto_renew_on' : 'auto_renew_off',
    });
  }
  return out;
}
