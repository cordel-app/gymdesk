/**
 * #2834 — the Membership Fee scope a Membership Plan's Pricing offers, mirroring
 * `api/src/domain/membershipFeeScope.ts` (a new scope goes there, in its CHECKs and here).
 * The label is a `plans.fee_scope_<value>` locale key, resolved by the page.
 */
export const MEMBERSHIP_FEE_SCOPES = ['per_member', 'per_family'] as const;
export type MembershipFeeScope = typeof MEMBERSHIP_FEE_SCOPES[number];

export const DEFAULT_MEMBERSHIP_FEE_SCOPE: MembershipFeeScope = 'per_family';

/** A stored value read back; anything unrecognised reads as the default, as the API does. */
export function toMembershipFeeScope(value: unknown): MembershipFeeScope {
  return typeof value === 'string' && (MEMBERSHIP_FEE_SCOPES as readonly string[]).includes(value)
    ? value as MembershipFeeScope
    : DEFAULT_MEMBERSHIP_FEE_SCOPE;
}

/** The locale key (`plans` namespace) a scope reads under. */
export function membershipFeeScopeLabelKey(scope: unknown): string {
  return `fee_scope_${toMembershipFeeScope(scope)}`;
}
