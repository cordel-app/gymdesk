/**
 * #2802 — the access a Membership Plan grants, described per beneficiary for display.
 *
 * Display only: it decides no access. Each entry is `resolveCenterAccess()` (the one
 * resolver the booking gate uses, `planCenterAccess.ts`) asked of this one plan for one
 * beneficiary, so the card cannot show a center the plan does not grant. Pure.
 */
import { resolveCenterAccess, type PlanCenterAccessInput } from './planCenterAccess';

export interface PlanAccessBeneficiary {
  member_id: number;
  name: string | null;
  /** The member's default center, read only when the plan's mode needs it. */
  defaultCenterId: number | null;
}

export interface PlanAccessEntry {
  member_id: number;
  member_name: string | null;
  /** Every physical center, current and future; `centers` is then empty. */
  all_centers: boolean;
  centers: { id: number; name: string }[];
  online: boolean;
}

/**
 * One entry per beneficiary the plan grants something to, in the order given. A center
 * the lookup does not know (deleted or inactive) is not listed, and a beneficiary the
 * plan grants nothing to (Only Member Default Center with no default) gets no entry.
 */
export function describePlanAccess(
  plan: PlanCenterAccessInput,
  centerNames: ReadonlyMap<number, string>,
  beneficiaries: readonly PlanAccessBeneficiary[],
): PlanAccessEntry[] {
  const out: PlanAccessEntry[] = [];
  for (const b of beneficiaries) {
    const access = resolveCenterAccess([plan], b.defaultCenterId);
    const centers = access.all ? [] : [...access.centerIds]
      .filter((id) => centerNames.has(id))
      .map((id) => ({ id, name: centerNames.get(id)! }))
      .sort((x, y) => x.name.localeCompare(y.name) || x.id - y.id);
    if (!access.all && centers.length === 0 && !access.online) continue;
    out.push({
      member_id: Number(b.member_id), member_name: b.name ?? null,
      all_centers: access.all, centers, online: access.online,
    });
  }
  return out;
}
