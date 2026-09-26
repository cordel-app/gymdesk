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
}

/** The assignment's frozen commercial configuration (#635 §11–§17). */
export interface AssignedPlanSnapshot {
  free_months: number | null;
  paid_months: number | null;
  /** #635 stage 13 — of `paid_months`, how many were already paid up front. */
  pay_beforehand_months: number | null;
  bonus_months: number | null;
  recurring_billing_interval: number | null;
  recurring_billing_unit: string | null;
  membership_fee_price: number | null;
  session_benefits: AssignedPlanSnapshotBenefit[];
  oneoff_benefits: AssignedPlanSnapshotBenefit[];
  periodical_benefits: AssignedPlanSnapshotBenefit[];
  /** False for an assignment that captured nothing — it still resolves live. */
  snapshot_captured: boolean;
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
  membership_fee_benefits: Array<{
    quantity: number; frequency_interval: number; frequency_unit: string;
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
  projected: boolean;
  event_type?: string;
  notes?: string | null;
}

export interface BillingEventsView {
  available: boolean;
  reason: string | null;
  projected: boolean;
  range_start: string | null;
  range_end: string | null;
  events: BillingEventItem[];
}

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
}
