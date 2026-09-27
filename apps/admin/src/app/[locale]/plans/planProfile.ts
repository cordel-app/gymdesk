import type { CSSProperties } from 'react';

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
 * The order the expanded card renders its sections in (§2). Price History comes
 * after Billing Events Forecast — §2 keeps it "available after these sections
 * using its existing behavior" rather than in the numbered list.
 */
export const PLAN_SECTION_ORDER = [
  'section_general',
  'section_pricing',
  'section_billing_duration',
  'section_oneoff_benefits',
  'section_session_benefits',
  'section_plan_period_benefits',
  'section_centers',
  'section_billing_forecast',
  'section_prices',
] as const;

export type PlanSectionKey = (typeof PLAN_SECTION_ORDER)[number];

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

// ─── Billing frequency (#820) ─────────────────────────────────────────────────
//
// The Billing & Duration section used to configure the cadence with a number box
// plus the whole `recurring_billing_unit` ENUM ("every 3 days", "every 2 years").
// #820 replaces both controls with a single dropdown of the two cadences a gym
// bills on — Month and 4 Weeks.
//
// What is stored does not change: the pair still goes to
// `PUT /membership-plans/:id/billing-policy` as `recurring_billing_interval` +
// `recurring_billing_unit`, which is what every assignment snapshots and what
// `advanceBillingDate()` steps. The API is the enforcer
// (`api/src/domain/planBillingFrequency.ts` — the same two pairs, rejected with
// a 400 otherwise); this declaration is what the dropdown offers and how a
// stored pair is read back, kept here rather than in the JSX so the option list,
// the mapping and the labels are one testable thing.

export const PLAN_BILLING_FREQUENCIES = ['month', 'four_weeks'] as const;

export type PlanBillingFrequency = (typeof PLAN_BILLING_FREQUENCIES)[number];

/** What each option stores, and the `plans.*` key that labels it. */
export const PLAN_BILLING_FREQUENCY_OPTIONS: Record<
  PlanBillingFrequency,
  { interval: number; unit: string; labelKey: string }
> = {
  month: { interval: 1, unit: 'month', labelKey: 'billing_frequency_month' },
  four_weeks: { interval: 4, unit: 'week', labelKey: 'billing_frequency_four_weeks' },
};

/** A new Plan is created monthly (`DEFAULT_BILLING_POLICY`). */
export const DEFAULT_PLAN_BILLING_FREQUENCY: PlanBillingFrequency = 'month';

/**
 * Which option a stored pair is, or `null` for a cadence outside the two: a
 * Plan configured before #820, or a row written straight into the database.
 * `null` is deliberately not coerced to an option — the read-only row keeps
 * showing what the Plan is really billed on ("Every 2 months"), and the editor
 * says so instead of relabelling it.
 */
export function planBillingFrequencyOf(interval: unknown, unit: unknown): PlanBillingFrequency | null {
  const n = Number(interval);
  if (!Number.isInteger(n)) return null;
  for (const freq of PLAN_BILLING_FREQUENCIES) {
    const opt = PLAN_BILLING_FREQUENCY_OPTIONS[freq];
    if (opt.interval === n && opt.unit === unit) return freq;
  }
  return null;
}

/** `{ interval, unit }` — what the choice stores. */
export function planBillingFrequencyCadence(freq: PlanBillingFrequency): { interval: number; unit: string } {
  const { interval, unit } = PLAN_BILLING_FREQUENCY_OPTIONS[freq];
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
 * option matches. A matched pair is labelled by its option's key instead, so
 * "Month" and "4 Weeks" read the same in the dropdown and in the read-only row.
 */
export function legacyBillingFrequencyText(interval: number, unit: string): string {
  return `Every ${interval === 1 ? unit : `${interval} ${unit}s`}`;
}
