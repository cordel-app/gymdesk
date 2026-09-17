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

export interface ChargeBenefitSnapshot {
  id: number;
  charge_type_code: string | null;
  gym_charge_name: string | null;
  gym_charge_amount: string | number | null;
  action: string;
  value: number | null;
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
  charge_benefits: ChargeBenefitSnapshot[];
  activity_allowances: ActivityAllowanceUsage[];
  promotions: AppliedPromotion[];
  billing_events: BillingEventsView;
}
