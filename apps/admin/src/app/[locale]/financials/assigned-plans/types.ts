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

export interface ActivityAllowanceUsage {
  activity_type_id: number;
  activity_type_name: string;
  allowance_type: 'unlimited' | 'session_count';
  allocated: number | null;
  used: number | null;
  remaining: number | null;
  recurrence_interval: number | null;
  recurrence_unit: string | null;
}

export interface AppliedPromotion {
  id: number;
  promotion_id: number;
  status: 'applied' | 'revoked';
  applied_at: string;
  revoked_at: string | null;
  promotion_name: string;
  promotion_description: string | null;
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
  charge_benefits: Array<{ charge_type_name: string; action: string; value: number | null }>;
  period_benefits: Array<{ charge_type_name: string; action: string; value: number | null; duration_months: number | null }>;
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
  final_price: string | number | null;
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
  activity_allowances: ActivityAllowanceUsage[];
  promotions: AppliedPromotion[];
  additional_services: AssignedPlanService[];
  billing_events: BillingEventsView;
}
