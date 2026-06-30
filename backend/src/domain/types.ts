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

export interface Subscription {
  id: number;
  gym_id: string;
  member_id: number;
  plan: string;
  starts_at: string;
  ends_at: string | null;
  status: string;
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
  role: 'admin' | 'coach' | 'staff' | 'member';
  created_at: string;
}
