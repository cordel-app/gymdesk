import type { CSSProperties } from 'react';
import {
  BillingEventSimulationBenefit,
  BillingEventSimulationData,
  BillingEventSimulationDate,
  BillingEventSimulationLine,
  simulationPriceLabelKey,
} from '@/lib/billingEventSimulation';
import {
  exampleTimelineRowTone,
  formatExampleTimelineBilling,
} from '@/lib/exampleTimeline';
import {
  PLAN_BILLING_FREQUENCIES,
  PLAN_BILLING_FREQUENCY_CADENCES,
  PlanBillingFrequency,
  billingFrequencyLabelKey,
  legacyCadenceText,
  planBillingFrequencyOf,
} from '@/lib/billingFrequency';

/**
 * #816 — the single declaration of the Membership Plan's expanded-card shape.
 *
 * Expanding a Membership Plan used to *read* four sections and *write* through
 * five section-level `Edit` buttons sitting inside the same card, while the
 * plan's own General fields (name, description, the two statuses, the member
 * limit) had no read-only rendering at all — expanding showed them only once
 * `⋮ → Edit` had replaced the whole body with the form. #816 puts Plans on the
 * #797/#798/#800 pattern: expanding reads the complete plan, `⋮ → Edit` is the
 * single entry point into every editor, and the section-level controls appear
 * only once the card is in Edit mode.
 *
 * So two things live here once:
 *
 * * `PLAN_SECTION_ORDER` — the order §2 specifies, as a property of the
 *   declaration rather than of the JSX, so a moved section is a failing test
 *   and not a review comment.
 * * `PLAN_GENERAL_SECTION` — the GENERAL field set both halves render: the
 *   keys and their order, the read-only labels, the formatting, and the
 *   persisted-row → form-values mapping the Edit action seeds with, plus the
 *   `PUT /membership-plans/:id` body it submits back.
 *
 * `member_count` is `editable: false`: the card has always shown "Members using
 * this plan" and no control has ever written it — it is a derived count, not a
 * column. Price, VAT, the durations, the cadence, the three Benefit sections
 * and the Centers are *not* part of this field set: each is its own resource
 * with its own endpoint and its own section-level editor (#635 §10), and #816
 * changes where those editors are reachable from, never what they submit.
 */

export const LIFECYCLE_STATUSES = ['draft', 'active', 'paused', 'inactive'] as const;
export const ENROLLMENT_STATUSES = ['public', 'staff_only'] as const;
export const MEMBER_LIMITS = ['1', '2', 'family'] as const;

export type PlanLifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];
export type PlanEnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];
export type PlanMemberLimit = (typeof MEMBER_LIMITS)[number];

/**
 * The order the expanded card renders its sections in (§2). #818 renamed the
 * last one: the Billing Events Forecast became the Example timeline, in the
 * same place.
 *
 * #962 renamed what that section is *called* — it reads **Membership Fee
 * Simulation** now, the same words the Promotion card and the Assigned Plan
 * card use for the same projection (`assigned_plans_page.section_fee_simulation`),
 * so the key is `section_fee_simulation` in all three namespaces. The
 * projection itself is untouched: the domain module is still
 * `planExampleTimeline.ts`, the API field is still `example_timeline`, and the
 * shared table is still `components/ExampleTimeline.tsx`.
 *
 * Price History is **not** in this list any more (#881). It used to trail the
 * Example timeline as a section of its own; it is now a collapsible card
 * rendered inside PRICING, which is where a plan's prices belong — see
 * `PLAN_PRICING_SUBSECTIONS`.
 */
export const PLAN_SECTION_ORDER = [
  'section_general',
  'section_pricing',
  'section_billing_duration',
  'section_oneoff_benefits',
  'section_session_benefits',
  'section_plan_period_benefits',
  'section_centers',
  'section_fee_simulation',
  // #915 — the Billing Event Simulation sits after the Membership Fee
  // Simulation: that one answers "what does each billing *period* do to the
  // Membership Fee", this answers "what is billed, in full, on each *date*".
  'section_billing_event_simulation',
] as const;

export type PlanSectionKey = (typeof PLAN_SECTION_ORDER)[number];

/**
 * What PRICING renders *within* itself, after its own fields (#881). Declared
 * here for the same reason as the section order: a sub-section that moves is a
 * failing test rather than a review comment, and "is Price History a section or
 * part of Pricing?" is answered in one place rather than by reading the JSX.
 *
 * A key here is deliberately absent from `PLAN_SECTION_ORDER` — rendering it in
 * both would show the history twice.
 */
export const PLAN_PRICING_SUBSECTIONS = ['section_prices'] as const;

export type PlanPricingSubsectionKey = (typeof PLAN_PRICING_SUBSECTIONS)[number];

/** The `membership_plans` columns the inline General form manages. */
export interface PlanGeneralProfile {
  name: string;
  description: string | null;
  lifecycle_status: PlanLifecycleStatus;
  enrollment_status: PlanEnrollmentStatus;
  member_limit: PlanMemberLimit;
}

/** Everything the GENERAL section renders — the editable columns plus the derived count. */
export interface PlanGeneralRow extends PlanGeneralProfile {
  member_count: number;
}

export type PlanGeneralFieldKey = keyof PlanGeneralRow;

/** How a value is rendered read-only. The Edit form's control is its own concern. */
export type PlanGeneralFieldFormat = 'text' | 'status' | 'member_limit' | 'count';

export interface PlanGeneralField {
  key: PlanGeneralFieldKey;
  /** Key in the admin `plans` translation namespace. */
  labelKey: string;
  format: PlanGeneralFieldFormat;
  /** `false` for a column the card shows but no control writes. */
  editable: boolean;
}

export interface PlanGeneralSection {
  /** Key in the admin `plans` translation namespace. */
  titleKey: Extract<PlanSectionKey, 'section_general'>;
  fields: PlanGeneralField[];
}

/**
 * §3's field list, in §3's order. The read-only view maps all of it; the inline
 * form maps `.filter((f) => f.editable)`, so the form's field order is a
 * property of this declaration too.
 *
 * The labels are the plain keys, never the form's: `label_name` is "Name *",
 * which is nonsense beside a value nobody can change (#797 rule 2).
 */
export const PLAN_GENERAL_SECTION: PlanGeneralSection = {
  titleKey: 'section_general',
  fields: [
    { key: 'name', labelKey: 'col_name', format: 'text', editable: true },
    { key: 'description', labelKey: 'col_description', format: 'text', editable: true },
    { key: 'lifecycle_status', labelKey: 'label_lifecycle_status', format: 'status', editable: true },
    { key: 'enrollment_status', labelKey: 'label_enrollment_status', format: 'status', editable: true },
    { key: 'member_limit', labelKey: 'label_member_limit', format: 'member_limit', editable: true },
    { key: 'member_count', labelKey: 'members_using_plan', format: 'count', editable: false },
  ],
};

export const PLAN_GENERAL_FIELDS: PlanGeneralField[] = PLAN_GENERAL_SECTION.fields;

/** The fields the inline Edit form renders a control for, in §3's order. */
export const PLAN_GENERAL_EDITABLE_FIELDS: PlanGeneralField[] = PLAN_GENERAL_FIELDS.filter((f) => f.editable);

/** The admin empty-value convention — never `null`, never `undefined`. */
export const EMPTY_VALUE = '—';

/** What PRICING reads for the Current price: the stored gross plus the server's split. */
export interface PlanCurrentPriceRow {
  current_price: string | null;
  amount_excl_tax: number | null;
  amount_incl_tax: number | null;
}

/**
 * #817 §2 — the Current price reads as the customer price *and* its net, e.g.
 *
 *     €60.00 VAT included (net €49.59 + tax = €60.00)
 *
 * Both numbers come from the server (`amount_incl_tax` / `amount_excl_tax`,
 * `computePriceFields()` over the rate the Plan actually bills at — its own, or
 * the gym's system rate when it is on "Default"), so the split shown here cannot
 * drift from the one the Pricing editor previews or the one Products
 * report. Nothing is recomputed in the frontend.
 *
 * A Plan whose gym has no tax rate at all has no split to show: it falls back to
 * the gross alone rather than to `—`, because the price *is* configured. No
 * price at all is the only `—`.
 */
export function formatPlanCurrentPrice(
  row: PlanCurrentPriceRow,
  /** `plans.tax_included_suffix` — "VAT included". */
  taxIncludedSuffix: string,
  /** `plans.price_preview` — "net €{excl} + tax = €{incl}", already interpolated. */
  formatSplit: (excl: string, incl: string) => string,
): string {
  if (row.current_price == null) return EMPTY_VALUE;
  if (row.amount_incl_tax == null || row.amount_excl_tax == null) {
    const gross = parseFloat(row.current_price);
    return Number.isFinite(gross) ? `€${gross.toFixed(2)}` : EMPTY_VALUE;
  }
  const incl = row.amount_incl_tax.toFixed(2);
  return `€${incl} ${taxIncludedSuffix} (${formatSplit(row.amount_excl_tax.toFixed(2), incl)})`;
}

/**
 * The read-only rendering of one GENERAL field. `translateStatus` is the page's
 * `status.*` lookup and `translateMemberLimit` its `plans.member_limit_*` one,
 * so the read-only values read as the labels the form's own selects show.
 */
export function formatPlanGeneralField(
  row: Partial<PlanGeneralRow>,
  field: PlanGeneralField,
  translateStatus: (key: string) => string,
  translateMemberLimit: (value: string) => string,
): string {
  const raw = row[field.key];
  if (raw === null || raw === undefined || raw === '') return EMPTY_VALUE;
  if (field.format === 'status') return translateStatus(String(raw));
  if (field.format === 'member_limit') return translateMemberLimit(String(raw));
  return String(raw);
}

/** The inline form's values. Every control is controlled, so no value is ever null. */
export interface PlanGeneralFormValues {
  name: string;
  description: string;
  lifecycle_status: PlanLifecycleStatus;
  enrollment_status: PlanEnrollmentStatus;
  member_limit: PlanMemberLimit;
}

export const EMPTY_PLAN_GENERAL_FORM: PlanGeneralFormValues = {
  name: '',
  description: '',
  lifecycle_status: 'draft',
  enrollment_status: 'staff_only',
  member_limit: '1',
};

/**
 * The persisted row → inline form values. `⋮ → Edit` seeds the form with this
 * and nothing else, so the form and the read-only view can only ever show the
 * same data.
 */
export function toPlanGeneralFormValues(row: PlanGeneralProfile): PlanGeneralFormValues {
  return {
    name: row.name,
    description: row.description ?? '',
    lifecycle_status: row.lifecycle_status,
    enrollment_status: row.enrollment_status,
    member_limit: row.member_limit,
  };
}

/**
 * The `PUT /membership-plans/:id` body, byte for byte what the pre-#816 inline
 * form sent: trimmed, and an emptied description cleared to `null` rather than
 * stored as `''`. #816 changes when the form is reachable, never what it
 * submits — price and VAT in particular stay out of it, because saving them is
 * what opens a new price and files the old one in the history (#547).
 */
export function toPlanGeneralUpdatePayload(values: PlanGeneralFormValues) {
  return {
    name: values.name.trim(),
    description: values.description.trim() || null,
    lifecycle_status: values.lifecycle_status,
    enrollment_status: values.enrollment_status,
    member_limit: values.member_limit,
  };
}

/** The one validation rule the form applies client-side: a Plan must keep a name. */
export function isPlanGeneralFormValid(values: PlanGeneralFormValues): boolean {
  return values.name.trim().length > 0;
}

/**
 * The Members-per-Membership chip, so the read-only row and any future control
 * read as the same badge rather than two colours that drift apart (#799 rule 11).
 */
export const memberLimitChipStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  padding: '2px 7px',
  borderRadius: 999,
  background: '#eef0ff',
  color: '#4b45c6',
};

// ─── Billing frequency (#820, labels #1128) ───────────────────────────────────
//
// The Billing & Duration section used to configure the cadence with a number box
// plus the whole `recurring_billing_unit` ENUM ("every 3 days", "every 2 years").
// #820 replaced both controls with a single dropdown of the two cadences a gym
// bills on.
//
// What is stored does not change: the pair still goes to
// `PUT /membership-plans/:id/billing-policy` as `recurring_billing_interval` +
// `recurring_billing_unit`, which is what every assignment snapshots and what
// `advanceBillingDate()` steps. The API is the enforcer
// (`api/src/domain/planBillingFrequency.ts` — the same two pairs, rejected with
// a 400 otherwise).
//
// The pair itself, the match and the **label** moved to `@/lib/billingFrequency`
// with #1128, because an Assigned Plan card renders the same cadence from
// `components/assignedPlan/` (which cannot import a page module) and because a
// Membership Plan has no frequency terminology of its own: `Monthly` and
// `Every 4 weeks` are the same words a Product billed on that period reads. This
// declaration re-exports them rather than restating them, and adds the one thing
// that is the Plan's own — the *period noun* a duration is counted in.

export {
  PLAN_BILLING_FREQUENCIES,
  planBillingFrequencyOf,
};
export type { PlanBillingFrequency };

/**
 * What each option stores, the `billing_frequency.*` key that labels the
 * frequency, and the `plans.*` key that names one of its periods.
 *
 * The two keys are two different sentences and may not be merged: the Billing
 * Frequency row reads `Every 4 weeks`, while a Paid Duration of two reads
 * `2 × 4 Weeks` (#892) — `2 × Every 4 weeks` is not English.
 */
export const PLAN_BILLING_FREQUENCY_OPTIONS: Record<
  PlanBillingFrequency,
  { interval: number; unit: string; labelKey: string; periodLabelKey: string }
> = {
  month: {
    ...PLAN_BILLING_FREQUENCY_CADENCES.month,
    labelKey: billingFrequencyLabelKey('month') as string,
    periodLabelKey: 'period_unit_month',
  },
  four_weeks: {
    ...PLAN_BILLING_FREQUENCY_CADENCES.four_weeks,
    labelKey: billingFrequencyLabelKey('four_weeks') as string,
    periodLabelKey: 'period_unit_four_weeks',
  },
};

/** A new Plan is created monthly (`DEFAULT_BILLING_POLICY`). */
export const DEFAULT_PLAN_BILLING_FREQUENCY: PlanBillingFrequency = 'month';

/** `{ interval, unit }` — what the choice stores. */
export function planBillingFrequencyCadence(freq: PlanBillingFrequency): { interval: number; unit: string } {
  const { interval, unit } = PLAN_BILLING_FREQUENCY_CADENCES[freq];
  return { interval, unit };
}

/**
 * The `PUT /membership-plans/:id/billing-policy` body, built here rather than in
 * the JSX so the section's Save and the default policy a new Plan is created
 * with cannot spell the pair out differently (#800's rule: the payload belongs
 * beside the form mapping).
 */
export function planBillingPolicyBody(freq: PlanBillingFrequency, autoRenew: boolean) {
  const { interval, unit } = planBillingFrequencyCadence(freq);
  return { recurring_billing_interval: interval, recurring_billing_unit: unit, auto_renew: autoRenew };
}

/**
 * `Every 2 months` — the pre-#820 rendering, kept for a legacy cadence that no
 * option matches. Re-exported from `@/lib/billingFrequency` under its original
 * name so the Plans page and an Assigned Plan card describe such a cadence with
 * one sentence.
 */
export const legacyBillingFrequencyText = legacyCadenceText;

// ─── Billing & Duration, in Billing Frequency periods (#892) ─────────────────
//
// A Membership Plan's Free Period / Paid Duration / Pre-paid Duration / Bonus
// Duration are **counts of the Plan's own Billing Frequency periods**, never of
// calendar months (`api/src/domain/planDuration.ts` is where that rule is
// applied to money; this is only how the number reads on screen). So the four
// fields are declared once, with the Billing Frequency the unit comes from, and
// the read-only summary, the Details modal and the editor's own suffix all
// render through `formatPlanDurationPeriods()`.

/** The four fields, in the order both halves of the section show them. */
export const PLAN_DURATION_FIELDS = [
  'free_periods', 'paid_periods', 'pay_beforehand_periods', 'bonus_periods',
] as const;

export type PlanDurationField = (typeof PLAN_DURATION_FIELDS)[number];

/** A stored `billing_policies` pair, as the Plan payload carries it. */
export interface PlanDurationCadenceSummary {
  recurring_billing_interval: number;
  recurring_billing_unit: string;
}

/**
 * How one period reads: `Month`, `4 Weeks`, or — for a Plan with no billing
 * policy, or one on a cadence outside #820's two — `null`, which is what makes
 * the value fall back to the neutral "{n} period(s)" form rather than naming a
 * frequency the Plan is not billed on. A legacy cadence is *not* spelled into
 * the duration ("2 × Every 2 months" reads as nonsense); the Billing Frequency
 * row beside it already says what the Plan bills on.
 */
export function planDurationUnitLabel(
  cadence: PlanDurationCadenceSummary | null | undefined,
  t: (key: string, values?: Record<string, unknown>) => string,
): string | null {
  if (!cadence) return null;
  const freq = planBillingFrequencyOf(cadence.recurring_billing_interval, cadence.recurring_billing_unit);
  return freq ? t(PLAN_BILLING_FREQUENCY_OPTIONS[freq].periodLabelKey) : null;
}

/**
 * What a duration field reads as: `2 × 4 Weeks` (§9 of the ticket), `2 month(s)`
 * when the Plan bills monthly — a count of monthly periods *is* a count of
 * months, and "2 × Month" would be a worse way to say so — and `2 period(s)`
 * when no frequency can be named. An unset field is "Not configured", never 0.
 */
export function formatPlanDurationPeriods(
  value: number | null | undefined,
  cadence: PlanDurationCadenceSummary | null | undefined,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  if (value == null) return t('not_configured');
  const freq = cadence
    ? planBillingFrequencyOf(cadence.recurring_billing_interval, cadence.recurring_billing_unit)
    : null;
  if (freq === 'month') return t('months_value', { n: value });
  const unit = planDurationUnitLabel(cadence, t);
  return unit != null
    ? t('periods_value', { n: value, frequency: unit })
    : t('periods_value_plain', { n: value });
}

// ─── Example timeline (#818) ──────────────────────────────────────────────────
//
// The Plan card's simulation is the Promotion card's: one row per billing
// period, with Period / Dates / Status / Billing. The rows themselves come from
// the server (`example_timeline`, `api/src/domain/planExampleTimeline.ts`) —
// which period is Free / Pre-paid / Pay / Bonus / regular is a billing rule and
// is never re-derived here. What lives in this declaration is how a row reads:
// its status label and its Billing cell.
//
// The labels say **(benefit)**, not (promotion): these are the Plan's own
// durations and no Promotion is involved, and the Plan's read-only rows already
// refuse the Promotion's vocabulary (#816 §14).

export const PLAN_TIMELINE_STATUSES = [
  'free_plan',
  'prepaid_plan',
  'pay_plan',
  'bonus_plan',
  'pay_regular',
] as const;

export type PlanTimelineStatus = (typeof PLAN_TIMELINE_STATUSES)[number];

/** The `plans.*` key labelling each status. */
export const PLAN_TIMELINE_STATUS_LABEL_KEYS: Record<PlanTimelineStatus, string> = {
  free_plan: 'timeline_free_benefit',
  prepaid_plan: 'timeline_prepaid_benefit',
  pay_plan: 'timeline_pay_benefit',
  bonus_plan: 'timeline_bonus_benefit',
  pay_regular: 'timeline_pay_regular',
};

/** One row of the server's projection. */
export interface PlanTimelinePeriod {
  period: number;
  status: PlanTimelineStatus;
  startsOn: string;
  endsOn: string | null;
  /** The VAT-inclusive price this period charges, `null` for no charge. */
  amount: number | null;
  waived: boolean;
  /**
   * #946 — how many Pre-paid periods `amount` covers, on the single row that
   * collects the Plan's Pre-paid Duration up front; `null` on every other row.
   */
  prepaidPeriods: number | null;
}

export interface PlanExampleTimeline {
  available: boolean;
  reason: string | null;
  currency: string;
  anchorDate: string | null;
  periods: PlanTimelinePeriod[];
}

/**
 * The Billing cell — the shared rule (`lib/exampleTimeline.ts`), under the name
 * this page already used. Since #924 stage 3 the Assigned Plan card's
 * Membership Fee Simulation renders the same table, so the formatting lives in
 * one place; only the labels are the page's.
 *
 * A waived period (Free, Bonus, or a Pre-paid one already
 * collected) reads "No charge"; a charged one quotes the Plan's current price
 * as the server computed it, VAT included — never recomputed here (#817). A
 * Plan with no price yet has nothing to quote, so it reads as the admin's empty
 * value rather than as €0.00, which would claim the member is charged nothing.
 *
 * #946 — the first Pre-paid period charges the fee for every period it pays
 * for, so its cell quotes that amount (the server's, again) and names the count
 * beside it: `€210.00 VAT included · 3 periods prepaid`. Without the note the
 * row would read as a single period costing three times the Plan's price.
 */
export function formatPlanTimelineBilling(
  row: Pick<PlanTimelinePeriod, 'amount' | 'waived'>,
  /** `plans.timeline_no_charge` — "No charge". */
  noChargeLabel: string,
  /** `plans.tax_included_suffix` — "VAT included". */
  taxIncludedSuffix: string,
  /** `plans.timeline_prepaid_periods`, already pluralised by the page; `null` otherwise. */
  prepaidNote?: string | null,
): string {
  return formatExampleTimelineBilling(row, noChargeLabel, taxIncludedSuffix, prepaidNote);
}

/**
 * Row tinting, the Promotion table's own three tones: green for a period that
 * charges nothing, grey for the regular ones, amber for the Plan's paid
 * durations in between.
 *
 * It reads the row rather than its status alone since #946: the first Pre-paid
 * period *charges* (it collects the whole Pre-paid Duration), and green is this
 * table's "no charge" tone — so a charged period of a configured duration takes
 * the amber one, exactly as a Pay period of the Paid Duration does.
 */
export function planTimelineRowTone(
  row: Pick<PlanTimelinePeriod, 'status' | 'waived'>,
): 'free' | 'regular' | 'benefit' {
  return exampleTimelineRowTone(row);
}

/* ── Billing Event Simulation (#915) ──────────────────────────────────────── */
//
// The wire shape and the price label are the shared projection's since #922 —
// the Promotion card renders the same section off the same types (see
// `lib/billingEventSimulation.ts` and the component beside it). Re-exported
// under the names this page already used, so the Plan keeps its own vocabulary
// (the keys resolve in the `plans.*` namespace) without a second declaration of
// the shape. A row's `period_status` is a `PlanTimelineStatus` here but typed as
// a plain string there, because the shared shape is both cards'.

export type PlanSimulationBenefit = BillingEventSimulationBenefit;
export type PlanSimulationLine = BillingEventSimulationLine;
export type PlanSimulationDate = BillingEventSimulationDate;
export type PlanBillingEventSimulation = BillingEventSimulationData;
export const planSimulationPriceLabelKey = simulationPriceLabelKey;
