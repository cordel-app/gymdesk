/**
 * #2879: the beneficiary selector of a Membership Plan assignment, decided in one pure
 * module. Staff choose from the family of the member the plan is assigned for; the
 * family owner is the assignment's owner (the payer) and need not be a beneficiary.
 *
 * The count is the plan's *Members per Membership* (`member_limit`): exactly 1 or 2, or
 * any number from one to the whole family for a `family` plan. The API judges the
 * selection again (`api/src/domain/planBeneficiaries.ts`); this module only drives the
 * toggles and the default.
 */
export type PlanMemberLimit = '1' | '2' | 'family';

export interface FamilyMemberOption {
  member_id: number;
  name: string;
  email?: string | null;
  is_owner: boolean;
}

/** How many beneficiaries the plan requires; `null` for a family plan. */
export function requiredBeneficiaryCount(limit: PlanMemberLimit | string | null | undefined): number | null {
  if (limit === 'family') return null;
  const n = parseInt(String(limit ?? '1'), 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** The family owner first, then everyone else alphabetically (case-insensitive, then id). */
export function orderFamilyMembers(members: readonly FamilyMemberOption[]): FamilyMemberOption[] {
  return [...members].sort((a, b) => {
    if (a.is_owner !== b.is_owner) return a.is_owner ? -1 : 1;
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return byName !== 0 ? byName : a.member_id - b.member_id;
  });
}

/** The owner of the family, else the first member in order (a member with no family row). */
export function familyOwnerId(members: readonly FamilyMemberOption[]): number | null {
  return orderFamilyMembers(members)[0]?.member_id ?? null;
}

/**
 * The selection a new assignment opens with: the family owner, then the others in
 * alphabetical order, until the plan's count is reached (the whole family for a family
 * plan). A family smaller than the count selects everyone, and `notEnoughFamilyMembers`
 * says so.
 */
export function defaultBeneficiaryIds(
  members: readonly FamilyMemberOption[], limit: PlanMemberLimit | string | null | undefined,
): number[] {
  const ordered = orderFamilyMembers(members).map((m) => m.member_id);
  const required = requiredBeneficiaryCount(limit);
  return required == null ? ordered : ordered.slice(0, required);
}

export function notEnoughFamilyMembers(
  members: readonly FamilyMemberOption[], limit: PlanMemberLimit | string | null | undefined,
): boolean {
  const required = requiredBeneficiaryCount(limit);
  return required != null && members.length < required;
}

/** Whether a member's toggle may be turned on: never past the plan's count. */
export function canSelectBeneficiary(
  selected: readonly number[], memberId: number, limit: PlanMemberLimit | string | null | undefined,
): boolean {
  if (selected.includes(memberId)) return true;
  const required = requiredBeneficiaryCount(limit);
  return required == null || selected.length < required;
}

/** Flips one toggle, refusing to go past the plan's count. */
export function toggleBeneficiary(
  selected: readonly number[], memberId: number, limit: PlanMemberLimit | string | null | undefined,
): number[] {
  if (selected.includes(memberId)) return selected.filter((id) => id !== memberId);
  return canSelectBeneficiary(selected, memberId, limit) ? [...selected, memberId] : [...selected];
}

export type BeneficiarySelectionIssue =
  | { key: 'not_enough_family_members'; count: number }
  | { key: 'none_selected' }
  | { key: 'exact_count'; count: number };

/** Why the selection cannot be saved yet, or `null` when it can. */
export function beneficiarySelectionIssue(
  members: readonly FamilyMemberOption[], selected: readonly number[], limit: PlanMemberLimit | string | null | undefined,
): BeneficiarySelectionIssue | null {
  const required = requiredBeneficiaryCount(limit);
  if (required != null && members.length < required) return { key: 'not_enough_family_members', count: required };
  if (selected.length === 0) return { key: 'none_selected' };
  if (required != null && selected.length !== required) return { key: 'exact_count', count: required };
  return null;
}

/** #2879 stage 2: the Members per Membership a Draft may be changed to (the API's set). */
export const PLAN_MEMBER_LIMITS: readonly PlanMemberLimit[] = ['1', '2', 'family'];

/**
 * #2879 stage 2: whether a Draft's beneficiary editor holds changes not yet saved — a
 * different limit, or a different set of beneficiaries (order does not matter).
 */
export function beneficiaryDraftChanged(
  saved: { memberLimit: string; ids: readonly number[] },
  draft: { memberLimit: string; ids: readonly number[] },
): boolean {
  if (saved.memberLimit !== draft.memberLimit) return true;
  const a = new Set(saved.ids);
  return a.size !== new Set(draft.ids).size || draft.ids.some((id) => !a.has(id));
}
