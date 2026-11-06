/**
 * #2383: the one place that decides which centers a Member may use through
 * their Membership Plans. Pure — the SQL half is `api/src/api/plan-center-access.ts`.
 */
export const PLAN_CENTER_ACCESS_MODES = ['specific_centers', 'all_centers', 'member_default_center'] as const;
export type PlanCenterAccessMode = (typeof PLAN_CENTER_ACCESS_MODES)[number];
export const DEFAULT_PLAN_CENTER_ACCESS_MODE: PlanCenterAccessMode = 'specific_centers';

export function isPlanCenterAccessMode(v: unknown): v is PlanCenterAccessMode {
  return typeof v === 'string' && (PLAN_CENTER_ACCESS_MODES as readonly string[]).includes(v);
}

export interface PlanCenterAccessInput {
  mode: PlanCenterAccessMode;
  /** The plan's `membership_plan_centers` rows (only meaningful for specific_centers). */
  centerIds: number[];
}

export interface EffectiveCenterAccess {
  /** True when every current and future center is allowed. */
  all: boolean;
  centerIds: Set<number>;
}

/**
 * Union of what each live plan grants. A `specific_centers` plan with no rows
 * keeps its pre-#2383 meaning (no restriction) so no existing member loses or
 * gains access. A `member_default_center` plan grants the Member's default
 * center only, and nothing when they have none.
 */
export function resolveCenterAccess(
  plans: PlanCenterAccessInput[],
  memberDefaultCenterId: number | null,
): EffectiveCenterAccess {
  const centerIds = new Set<number>();
  for (const p of plans) {
    if (p.mode === 'all_centers') return { all: true, centerIds };
    if (p.mode === 'member_default_center') {
      if (memberDefaultCenterId != null) centerIds.add(Number(memberDefaultCenterId));
      continue;
    }
    if (p.centerIds.length === 0) return { all: true, centerIds };
    for (const c of p.centerIds) centerIds.add(Number(c));
  }
  return { all: false, centerIds };
}

export function centerAllowed(access: EffectiveCenterAccess, centerId: number): boolean {
  return access.all || access.centerIds.has(Number(centerId));
}

/** Request parsing for `PUT /membership-plans/:id/centers`. */
export function parseCenterAccessInput(
  body: { center_access_mode?: unknown; center_ids?: unknown },
): { error: string } | { mode: PlanCenterAccessMode | null; centerIds: unknown[] } {
  let mode: PlanCenterAccessMode | null = null;
  if (body.center_access_mode !== undefined) {
    if (!isPlanCenterAccessMode(body.center_access_mode)) return { error: 'center_access_mode is not valid' };
    mode = body.center_access_mode;
  }
  if (body.center_ids === undefined) {
    if (mode && mode !== 'specific_centers') return { mode, centerIds: [] };
    return { error: 'center_ids must be an array' };
  }
  if (!Array.isArray(body.center_ids)) return { error: 'center_ids must be an array' };
  return { mode, centerIds: body.center_ids };
}
