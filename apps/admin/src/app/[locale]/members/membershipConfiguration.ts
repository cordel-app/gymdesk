// #634 — the shapes returned by GET /user-memberships/member/:id/configuration.
//
// One read backs the three configuration sections of the Member → Membership
// experience (MEMBERSHIP PLANS, PROMOTIONS, ADDITIONAL SERVICES); the fourth,
// BILLING SIMULATION, has its own endpoint from #629. Promotions and Services
// are Member-level lists, never nested inside a Membership Plan card (§13), so
// each row carries the Assigned Plan it belongs to.

import type { AssignedPlanService } from '../financials/assigned-plans/types';

export interface MemberPlanRow {
  /** The Assigned Plan (user_memberships) id — what every write is addressed to. */
  id: number;
  membership_plan_id: number | null;
  plan_name: string | null;
  status: string;
  final_price: string | null;
  starts_at: string | null;
  ends_at: string | null;
  next_billing_date: string | null;
  /**
   * The plan still has billing ahead of it (draft/awaiting_payment/active/
   * paused), so it is part of the Member's current configuration. Terminal
   * plans stay listed as history — #412's full plan history is unchanged by
   * #634 — but nothing can be attached to them.
   */
  is_live: boolean;
  /**
   * #634 §3 — whether a Promotion flagged "Only applicable for new members"
   * would be accepted on this plan: the Member held no other Membership Plan
   * in the trailing 12 months. Reported per plan because the plan a Promotion
   * is attached to never counts against its own Member, so a Member's first
   * plan and their second can differ. Server-computed; the API enforces it.
   */
  new_member_eligible: boolean;
}

export interface MemberPromotionRow {
  id: number;
  user_membership_id: number;
  plan_name: string | null;
  promotion_id: number;
  promotion_name: string | null;
  status: string;
  applied_at: string | null;
  revoked_at: string | null;
  /** MySQL TINYINT(1), i.e. 0/1 over JSON. */
  stackable: boolean | number;
}

export type MemberServiceRow = AssignedPlanService & { plan_name: string | null };

export interface MemberConfiguration {
  plans: MemberPlanRow[];
  promotions: MemberPromotionRow[];
  services: MemberServiceRow[];
}

export const EMPTY_CONFIGURATION: MemberConfiguration = { plans: [], promotions: [], services: [] };
