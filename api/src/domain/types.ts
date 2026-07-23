export interface Member {
  id: number;
  gym_id: string;
  name: string;
  email: string;
  phone: string | null;
  deleted_at: string | null;
  created_at: string;
}

export interface GymClass {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  capacity: number;
  starts_at: string;
  ends_at: string;
  created_at: string;
}

export interface Booking {
  id: number;
  gym_id: string;
  member_id: number;
  class_id: number;
  status: string;
  created_at: string;
}

export interface MembershipPlan {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  base_price: string;
  status: 'active' | 'inactive';
  created_at: string;
}

export interface ChargeType {
  id: number;
  code: string;
  active: boolean;
  created_at: string;
}

export interface BillingEvent {
  id: number;
  gym_id: string;
  user_membership_id: number | null;
  member_id: number | null;
  event_type: 'charge_created' | 'payment_recorded' | 'status_changed' | 'adjustment';
  charge_type_id: number | null;
  previous_status: string | null;
  new_status: string | null;
  source: 'admin' | 'system' | 'employee' | 'customer' | 'provider';
  actor_user_id: string | null;
  amount: string | null;
  notes: string | null;
  created_at: string;
}

export interface Gym {
  id: string;
  name: string;
  slug: string;
  plan: 'free' | 'pro';
  created_at: string;
}

export interface GymMembership {
  id: number;
  user_id: string;
  gym_id: string;
  role: 'admin' | 'trainer_performance' | 'trainer_perf_nutrition' | 'front_desk' | 'accountant' | 'nutritionist' | 'member';
  created_at: string;
}
