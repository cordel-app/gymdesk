/**
 * #924 stage 5 — the single declaration of the Assigned Plan card's shape.
 *
 * The Membership Plan card declares its own section order in `planProfile.ts`
 * (`PLAN_SECTION_ORDER`, #816) rather than in the JSX, so a moved section is a
 * failing test and not a review comment. This is the same declaration for the
 * card §1 asks to match it: an Assigned Plan is a Membership Plan with the
 * assigned person's context, an optional applied Promotion and its own
 * Additional Products, so its sections are the Plan's sections in the Plan's
 * order with those three added where they belong.
 *
 * The keys are locale keys in the admin `assigned_plans_page` namespace, and
 * the list is flat on purpose. Until this stage the five sections that come
 * from the Membership Plan sat nested under one `MEMBERSHIP PLAN
 * CONFIGURATION` heading the Plan card has no counterpart for — a level of
 * structure that is exactly the "separate visual system" §1 forbids. They are
 * rendered by `AssignedPlanConfiguration`, which owns a contiguous slice of
 * this list (`ASSIGNED_PLAN_CONFIGURATION_SECTIONS`); every other key is
 * rendered by `AssignedPlanExpandedRow` itself.
 */
export const ASSIGNED_PLAN_SECTION_ORDER = [
  // §2 — the one section a Membership Plan cannot have: who holds this plan.
  // It stands where the Plan card's GENERAL does, because it is what identifies
  // the row.
  'section_members',
  // The agreed fee, the window and the cadence — the Plan card's PRICING.
  'section_pricing',
  // ↓ The five the assignment's own snapshot owns (§9/§15), in the Plan card's
  // order: Billing & Duration, then the three Sellable Item benefit sections.
  // The Personal Membership Fee Benefit (#772) sits directly under the fee it
  // discounts, which is the only one of the five a Membership Plan has not got.
  'section_billing_duration',
  'section_membership_fee_benefit',
  'benefits_oneoff',
  'benefits_session',
  'benefits_period',
  // §3/§6 — the Promotions this assignment was agreed with, each from its own
  // snapshot.
  'section_promotions',
  // §7 then §8: one row per billing *period* about the Membership Fee, then one
  // group per billing *date* listing every line that falls on it. Same order as
  // the Plan card's Example Timeline and Billing Event Simulation, and neither
  // may grow into the other.
  'section_fee_simulation',
  'section_billing_forecast',
  // §11 — kept, and last of the sections that describe the agreement. Renamed
  // *Additional Products* in this stage, per the thread's answer to Q4.
  'section_additional_services',
  // The ledger of what has actually been charged. A Membership Plan cannot have
  // one, and it trails everything because the two simulations above answer
  // "what will happen" and this answers "what happened" (the thread's Q4
  // answer: keep it).
  'section_billing_events',
] as const;

export type AssignedPlanSectionKey = (typeof ASSIGNED_PLAN_SECTION_ORDER)[number];

/**
 * The slice of that order `AssignedPlanConfiguration` renders — the sections
 * that come from the Membership Plan and are edited against this assignment's
 * own snapshot.
 *
 * Declared here rather than beside the component for the reason the order
 * itself is: "which sections are the snapshot's?" is answered in one place, and
 * the slice being contiguous is what makes the flat order above true of the
 * rendered card.
 */
export const ASSIGNED_PLAN_CONFIGURATION_SECTIONS = [
  'section_billing_duration',
  'section_membership_fee_benefit',
  'benefits_oneoff',
  'benefits_session',
  'benefits_period',
] as const;

export type AssignedPlanConfigurationSectionKey =
  (typeof ASSIGNED_PLAN_CONFIGURATION_SECTIONS)[number];
