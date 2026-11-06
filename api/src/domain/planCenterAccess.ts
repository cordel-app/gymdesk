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

/**
 * #2406: the stable identifier of the On-line center — remote services (online
 * personal training, coaching). It is not a `centers` row (that would join every
 * physical-center query in the product); a plan selects it through
 * `membership_plans.online_access`, and it is only meaningful in
 * `specific_centers` mode. `all_centers` means every physical center and never
 * includes it.
 */
export const ONLINE_CENTER_KEY = 'online';

export interface PlanCenterAccessInput {
  mode: PlanCenterAccessMode;
  /** On-line selected (specific_centers only). */
  online?: boolean;
  /** The plan's `membership_plan_centers` rows (only meaningful for specific_centers). */
  centerIds: number[];
}

export interface EffectiveCenterAccess {
  /** True when every current and future center is allowed. */
  all: boolean;
  centerIds: Set<number>;
  /** True when some live plan selects the On-line center. */
  online: boolean;
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
  const online = plans.some((p) => p.mode === 'specific_centers' && p.online === true);
  for (const p of plans) {
    if (p.mode === 'all_centers') return { all: true, centerIds, online };
    if (p.mode === 'member_default_center') {
      if (memberDefaultCenterId != null) centerIds.add(Number(memberDefaultCenterId));
      continue;
    }
    // An On-line-only plan restricts to no physical center; a plan with neither
    // keeps its legacy meaning (no restriction).
    if (p.centerIds.length === 0) {
      if (p.online === true) continue;
      return { all: true, centerIds, online };
    }
    for (const c of p.centerIds) centerIds.add(Number(c));
  }
  return { all: false, centerIds, online };
}

export function centerAllowed(access: EffectiveCenterAccess, centerId: number): boolean {
  return access.all || access.centerIds.has(Number(centerId));
}

export function onlineAllowed(access: EffectiveCenterAccess): boolean {
  return access.online;
}

/** Request parsing for `PUT /membership-plans/:id/centers`. */
export function parseCenterAccessInput(
  body: { center_access_mode?: unknown; center_ids?: unknown; online_access?: unknown },
): { error: string } | { mode: PlanCenterAccessMode | null; centerIds: unknown[]; online: boolean | null } {
  let online: boolean | null = null;
  if (body.online_access !== undefined) {
    if (typeof body.online_access !== 'boolean') return { error: 'online_access must be a boolean' };
    online = body.online_access;
  }
  let mode: PlanCenterAccessMode | null = null;
  if (body.center_access_mode !== undefined) {
    if (!isPlanCenterAccessMode(body.center_access_mode)) return { error: 'center_access_mode is not valid' };
    mode = body.center_access_mode;
  }
  if (body.center_ids === undefined) {
    if (mode && mode !== 'specific_centers') return { mode, centerIds: [], online };
    return { error: 'center_ids must be an array' };
  }
  if (!Array.isArray(body.center_ids)) return { error: 'center_ids must be an array' };
  return { mode, centerIds: body.center_ids, online };
}
