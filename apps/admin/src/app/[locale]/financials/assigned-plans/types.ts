import type { SellableItemBenefitAction } from '@/lib/sellableItemBenefitActions';
import type { SessionBenefitFrequency } from '@/lib/sessionBenefitFrequency';
import type { BillingEventSimulationData } from '@/lib/billingEventSimulation';
import type {
  ExampleTimelineProjection,
  ExampleTimelineStatus,
} from '@/lib/exampleTimeline';

export interface AssignedPlanMember {
  member_id: number;
  is_owner: number | boolean;
  name: string;
  email: string;
}

export interface BillingPolicy {
  id: number;
  recurring_billing_interval: number;
  recurring_billing_unit: 'day' | 'week' | 'month' | 'year';
  auto_renew: number | boolean;
}

/**
 * One benefit line of the assignment's own #635 snapshot — the Sellable Item as
 * it was priced and named when the plan was assigned, never the live catalogue.
 */
export interface AssignedPlanSnapshotBenefit {
  id: number;
  gym_charge_id: number;
  quantity: number;
  item_name: string;
  item_type: string;
  item_billing_frequency: string | null;
  unit_price: number;
  currency: string | null;
  /**
   * #896 — the pricing treatment this line was agreed with, frozen beside the
   * price. Read in the Membership Plan's option set, which is where the line
   * came from: `no_benefit`, `waive` or `percentage_discount` (§16).
   */
  action: SellableItemBenefitAction;
  value: number | null;
  /**
   * #918 — a Session line's agreed renewal Frequency ("2 sessions every week").
   * `null` for the other two sections, which have no such column, and for a
   * session line the Plan never configured one on.
   */
  frequency: SessionBenefitFrequency | null;
  /**
   * #924 stage 1 — what the line costs before and after its own treatment, VAT
   * included, as the server computed it from the **frozen** price (§17). The
   * page formats these; it never prices (#817).
   */
  original_price_incl_tax: number | null;
  final_price_incl_tax: number | null;
  original_line_price_incl_tax: number | null;
  final_line_price_incl_tax: number | null;
}

/** The assignment's frozen commercial configuration (#635 §11–§17). */
export interface AssignedPlanSnapshot {
  // #892 (migration 201) — counts of this assignment's own Billing Frequency
  // periods (`recurring_billing_interval` × `recurring_billing_unit` below),
  // never of calendar months.
  free_periods: number | null;
  paid_periods: number | null;
  /** #635 stage 13 — of `paid_periods`, how many were already paid up front. */
  pay_beforehand_periods: number | null;
  bonus_periods: number | null;
  recurring_billing_interval: number | null;
  recurring_billing_unit: string | null;
  membership_fee_price: number | null;
  session_benefits: AssignedPlanSnapshotBenefit[];
  oneoff_benefits: AssignedPlanSnapshotBenefit[];
  periodical_benefits: AssignedPlanSnapshotBenefit[];
  /**
   * #772 — the assignment's own Personal Membership Fee Benefit. Not part of
   * the frozen snapshot and not part of `snapshot_captured`: it is agreed with
   * this member rather than captured from the catalogue, and it never expires.
   */
  personal_fee_benefit: PersonalFeeBenefit;
  /** False for an assignment that captured nothing — it still resolves live. */
  snapshot_captured: boolean;
}

/** #772 — the options the Assigned Plan's Membership Fee Benefit section offers. */
export type PersonalFeeBenefitAction = 'no_benefit' | 'percentage_discount';

export interface PersonalFeeBenefit {
  action: PersonalFeeBenefitAction;
  /** The percentage, 0..100. Always null for `no_benefit`. */
  value: number | null;
}

/**
 * One Sellable Item an applied Promotion granted, frozen at the price and
 * frequency it was agreed at (#635 §16/§17) — never the catalogue's current
 * ones, which is why the card shows `unit_price` from the line itself.
 */
export interface AppliedPromotionGrant {
  gym_charge_id: number | null;
  item_name: string;
  quantity: number;
  item_billing_frequency: string | null;
  unit_price: number;
  /**
   * #924 stage 2 — what this grant does to the line, as the application agreed
   * it (#896 §15). Read server-side in the **Promotion**'s option set, so all
   * five actions can appear here where a Plan benefit has only three.
   */
  action: SellableItemBenefitAction;
  value: number | null;
  /**
   * #924 stage 2 — the Agreed / Final Price pair, VAT included, computed by the
   * server from the **frozen** unit price and the pair above (§17). The page
   * formats them; it never prices (#817).
   */
  original_price_incl_tax: number | null;
  final_price_incl_tax: number | null;
  original_line_price_incl_tax: number | null;
  final_line_price_incl_tax: number | null;
}

export interface AppliedPromotion {
  id: number;
  promotion_id: number;
  status: 'applied' | 'revoked';
  /**
   * #635 stage 7 — how the application reads on the card, computed server-side
   * from its own agreed window: `active`, `inactive` (revoked) or `expired`.
   */
  display_status: 'active' | 'inactive' | 'expired';
  /**
   * #635 stage 9 — whether this spent application may be agreed again (the
   * thread's Q2 answer, "selectable and deselectable"). Decided server-side by
   * `canReapplyPromotion()`: false while the application still stands, while
   * another application of the same Promotion does, and for a Promotion that is
   * no longer active or is outside its own window today.
   */
  can_reapply: boolean;
  applied_at: string;
  revoked_at: string | null;
  /** The staff member who applied it — the card's "created by". */
  applied_by_name: string | null;
  promotion_name: string;
  promotion_description: string | null;
  /** The agreed promotional window — the snapshot's dates, not the Promotion's current ones. */
  starts_at: string | null;
  ends_at: string | null;
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  // #635 stage 5: the Membership Fee Benefit frozen onto the application —
  // one entry, or a second one for an application snapshotted before that
  // stage, when the same benefit could also be configured as a Charge
  // Benefit. The `charge_benefits` / `period_benefits` arrays it replaces are
  // gone, along with the tables behind them (migration 179).
  // #814: the benefit is these four fields; the recurrence triplet it used to
  // carry (quantity / frequency_interval / frequency_unit) is gone with
  // migration 199. This card never displayed them.
  membership_fee_benefits: Array<{
    enabled: boolean; action: string | null; value: number | null; duration_months: number | null;
  }>;
  // #635 stage 7 — the Sellable Items the application granted, read from its
  // own snapshot (§16), so editing or deleting the Promotion never moves them.
  session_grants: AppliedPromotionGrant[];
  oneoff_grants: AppliedPromotionGrant[];
  periodical_grants: AppliedPromotionGrant[];
}

/**
 * #631 — an Additional Periodic Service attached to the Assigned Plan. The
 * name, price and frequency are the Sellable Item's own, read live by the API;
 * `ends_at` is the effective removal date (removal is future-only), `active`
 * is false once it has passed, and `sellable_item_retired` marks an item that
 * was soft-deleted or deactivated after being attached (it still bills).
 */
export interface AssignedPlanService {
  id: number;
  user_membership_id: number;
  gym_charge_id: number;
  quantity: number;
  starts_at: string;
  ends_at: string | null;
  sellable_item_name: string;
  billing_frequency: string | null;
  unit_price: number;
  currency: string | null;
  active: boolean;
  sellable_item_retired: boolean;
}

export interface BillingEventItem {
  date: string;
  amount: string | number | null;
  promotion_affected: boolean;
  event_type?: string;
  notes?: string | null;
}

export interface BillingEventsView {
  available: boolean;
  reason: string | null;
  range_start: string | null;
  range_end: string | null;
  events: BillingEventItem[];
}

/* ── Membership Fee Simulation (#924 stage 3, §7) ─────────────────────────── */
//
// The Membership Plan card's Example Timeline (#818), for this contract: one
// row per billing period of the assignment's own cadence, each priced by the
// same `resolveMembershipFee()` the nightly run charges with. The rows come
// from the server (`example_timeline`) — which period is Free / Pre-paid /
// Pay / Bonus and whether the Plan's duration or an applied Promotion decided
// it are billing rules and are never re-derived here. What lives in this
// declaration is how a row *reads*.
//
// Unlike the Plan card's version the labels may say **(promotion)**: an
// Assigned Plan really can be inside one, and #635's Q2 answer is that where a
// Promotion governs a date it decides the fee alone — so naming the Plan's own
// durations there would attribute the price to the wrong agreement.

export const ASSIGNED_PLAN_TIMELINE_STATUSES: ExampleTimelineStatus[] = [
  'free_plan', 'prepaid_plan', 'pay_plan', 'bonus_plan',
  'free_promotion', 'prepaid_promotion', 'pay_promotion', 'bonus_promotion',
  'pay_regular',
];

/** The `assigned_plans_page.*` key labelling each status. */
export const ASSIGNED_PLAN_TIMELINE_STATUS_LABEL_KEYS: Record<ExampleTimelineStatus, string> = {
  free_plan: 'timeline_free_plan',
  prepaid_plan: 'timeline_prepaid_plan',
  pay_plan: 'timeline_pay_plan',
  bonus_plan: 'timeline_bonus_plan',
  free_promotion: 'timeline_free_promotion',
  prepaid_promotion: 'timeline_prepaid_promotion',
  pay_promotion: 'timeline_pay_promotion',
  bonus_promotion: 'timeline_bonus_promotion',
  pay_regular: 'timeline_pay_regular',
};

export interface AssignedPlanDetail {
  id: number;
  status: string;
  lifecycle_status: string;
  member_id: number;
  member_name: string;
  member_nif_nie_passport: string | null;
  membership_plan_id: number | null;
  plan_name: string | null;
  base_price: string | number | null;
  /** The Membership Fee resolved for this assignment's current cycle (#635 stage 15). */
  membership_fee: number | null;
  discount_reason: string | null;
  discount_expires_at: string | null;
  starts_at: string;
  ends_at: string | null;
  closed_at: string | null;
  next_billing_date: string | null;
  created_at: string;
  created_by_name: string | null;
  modified_by_name: string | null;
  modified_at: string | null;
  members: AssignedPlanMember[];
  billing_policy: BillingPolicy | null;
  snapshot: AssignedPlanSnapshot;
  promotions: AppliedPromotion[];
  additional_services: AssignedPlanService[];
  billing_events: BillingEventsView;
  /**
   * #924 stage 3 — the Membership Fee Simulation. `null` only for a response
   * written before the projection existed; the card renders the unavailable
   * line for it, exactly as it does for an assignment with no billing
   * frequency.
   */
  example_timeline: ExampleTimelineProjection | null;
  /**
   * #924 stage 4 (§8) — the Billing Event Forecast: one group per billing
   * *date*, carrying every line that falls on it. Where `example_timeline`
   * above is one row per billing *period* and is about the Membership Fee
   * alone, this one adds the Sellable Items, the standing Promotions' grants
   * and the Additional Periodic Services. Both are the server's, computed on
   * every read and persisted nowhere.
   */
  billing_event_simulation: BillingEventSimulationData | null;
}
