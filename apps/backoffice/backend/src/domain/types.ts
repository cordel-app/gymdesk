export interface Member {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  created_at: string;
}

export interface GymClass {
  id: number;
  name: string;
  description: string | null;
  capacity: number;
  starts_at: string;
  ends_at: string;
  created_at: string;
}

export interface Booking {
  id: number;
  member_id: number;
  class_id: number;
  status: string;
  created_at: string;
}

export interface Subscription {
  id: number;
  member_id: number;
  plan: string;
  starts_at: string;
  ends_at: string | null;
  status: string;
  created_at: string;
}
