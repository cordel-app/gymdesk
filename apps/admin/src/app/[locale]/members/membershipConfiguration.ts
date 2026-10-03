// #634 — the shapes returned by GET /user-memberships/member/:id/configuration.
//
// One read backs the two configuration sections of the Member → Membership
// experience (MEMBERSHIP PLANS, ADDITIONAL SERVICES); the third, BILLING
// SIMULATION, has its own endpoint from #629. Services are a Member-level list,
// never nested inside a Membership Plan card (§13), so each row carries the
// Assigned Plan it belongs to.
//
// #931 — Promotions are not part of a Member's configuration: a Promotion
// applies to a Membership Plan or a Product, never to a Member, so neither
// this payload nor the Member card carries them. The applications an Assigned
// Plan was agreed with are read from the Assigned Plans card instead.

import type { AssignedPlanService } from '../financials/assigned-plans/types';

export interface MemberPlanRow {
  /** The Assigned Plan (user_memberships) id — what every write is addressed to. */
  id: number;
  membership_plan_id: number | null;
  plan_name: string | null;
  status: string;
  membership_fee: number | null;
  starts_at: string | null;
  ends_at: string | null;
  next_billing_date: string | null;
  /**
   * The plan still has billing ahead of it (active/paused), so it is part of the Member's current configuration. Terminal
   * plans stay listed as history — #412's full plan history is unchanged by
   * #634 — but nothing can be attached to them.
   */
  is_live: boolean;
  /**
   * #634 §3 — whether a Promotion flagged "Only applicable for new members"
   * would be accepted on this plan: the Member held no other Membership Plan
   * in the trailing 12 months. Reported per plan because the plan a Promotion
   * is attached to never counts against its own Member, so a Member's first
   * plan and their second can differ. Server-computed, and the API is the
   * enforcement point — the #931 removal of the PROMOTIONS section took away
   * the picker that read it here, not the rule.
   */
  new_member_eligible: boolean;
}

export type MemberServiceRow = AssignedPlanService & { plan_name: string | null };

export interface MemberConfiguration {
  plans: MemberPlanRow[];
  services: MemberServiceRow[];
}

export const EMPTY_CONFIGURATION: MemberConfiguration = { plans: [], services: [] };
