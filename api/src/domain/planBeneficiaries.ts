/**
 * #2879: who a Membership Plan assignment may cover, judged once.
 *
 * Staff choose a plan's beneficiaries from the family of the assignment's owner (the
 * payer), and the owner need not be one of them. The plan's `member_limit` (*Members
 * per Membership*) fixes how many: exactly 1 or 2, or, for a `family` plan, at least
 * one and at most the whole family. Pure: the router loads the family and asks.
 *
 * The admin mirrors the default selection and the toggle rule in
 * `apps/admin/src/lib/planBeneficiaries.ts`; the server never trusts that mirror.
 */
export type PlanMemberLimit = '1' | '2' | 'family';

/** How many beneficiaries a plan requires, or `null` for a family plan (any count ≥ 1). */
export function requiredBeneficiaryCount(limit: string | null | undefined): number | null {
  if (limit === 'family') return null;
  const n = parseInt(String(limit ?? '1'), 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export type BeneficiarySelectionError =
  | { code: 'beneficiaries_required'; error: string }
  | { code: 'beneficiary_count'; error: string }
  | { code: 'beneficiary_not_in_family'; error: string; member_ids: number[] };

/**
 * Whether `beneficiaryIds` is a valid selection for a plan of `limit` drawn from
 * `familyMemberIds` (the owner's family, the owner included). The count is judged before
 * family membership, so a wrong count reads as one whatever members were named.
 */
export function beneficiarySelectionError(input: {
  limit: string | null | undefined;
  familyMemberIds: readonly number[];
  beneficiaryIds: readonly number[];
}): BeneficiarySelectionError | null {
  const ids = [...new Set(input.beneficiaryIds)];
  if (ids.length === 0) {
    return { code: 'beneficiaries_required', error: 'Select at least one beneficiary.' };
  }
  const required = requiredBeneficiaryCount(input.limit);
  if (required != null && ids.length !== required) {
    return { code: 'beneficiary_count', error: `This plan requires exactly ${required} member(s).` };
  }
  const family = new Set(input.familyMemberIds);
  const outside = ids.filter((id) => !family.has(id));
  if (outside.length > 0) {
    return {
      code: 'beneficiary_not_in_family',
      error: "Every beneficiary must be a member of the owner's family.",
      member_ids: outside,
    };
  }
  return null;
}

/**
 * Parses `beneficiary_member_ids`: `undefined` when absent (the caller falls back to the
 * legacy `member_ids`), `null` when malformed, else the de-duplicated ids.
 */
export function parseBeneficiaryIds(value: unknown): number[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const v of value) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n <= 0) return null;
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}
