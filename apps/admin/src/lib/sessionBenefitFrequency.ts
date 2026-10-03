// #918 — a Session Benefit's **Frequency**: the period on which its included
// sessions are renewed ("2 Personal Training Classes per week").
//
// Mirrored from `api/src/domain/sessionBenefitFrequency.ts`, which is what
// actually enforces it (a frontend-only list is not a rule) and what the
// `chk_<table>_frequency` CHECK of migration 205 backs up. This copy exists for
// the same reason `lib/productBenefitActions.ts` does: the editor has to
// render the options, and it must not spell the list out inline. A new value
// therefore goes in the API module, its CHECK, *and* here —
// `session-benefit-frequency-ui.test.ts` fails if this copy drifts.
//
// Deliberately **not** the Product's own `billing_frequency` list: that
// one answers how often an item is *priced* and #821 retired `week` from it,
// while this one answers how often an allowance *renews* and weekly is the case
// the field exists for. `per_session` is not a period and is not offered.
//
// The labels are locale keys the owning page resolves (`plans.session_frequency_*`),
// so nothing about wording lives here.

export type SessionBenefitFrequency = 'once' | 'week' | 'four_weeks' | 'month' | 'year';

/** What the Frequency select offers, in order, after its `—` placeholder. */
export const SESSION_BENEFIT_FREQUENCIES: readonly SessionBenefitFrequency[] = [
  'once',
  'week',
  'four_weeks',
  'month',
  'year',
];

/**
 * `—`: no Frequency configured, which is what every Session Benefit stored
 * before #918 holds and what a one-time allowance of N sessions means. It is a
 * real stored state (`NULL`), not the absence of an answer, so the option is
 * part of the select rather than a disabled placeholder.
 */
export const NO_SESSION_BENEFIT_FREQUENCY = '' as const;

/** The locale key for one value — `—` included, so a caller never branches. */
export function sessionFrequencyLabelKey(value: SessionBenefitFrequency | null | undefined): string {
  return value ? `session_frequency_${value}` : 'session_frequency_none';
}

/** What the select writes back: a known value, or `null` for `—`. */
export function toSessionBenefitFrequency(raw: string): SessionBenefitFrequency | null {
  return (SESSION_BENEFIT_FREQUENCIES as readonly string[]).includes(raw)
    ? (raw as SessionBenefitFrequency)
    : null;
}
