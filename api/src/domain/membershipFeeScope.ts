/**
 * #2834 — a Membership Plan's **Membership Fee scope**: whether its fee is charged once for the
 * whole plan assignment (`per_family`, the default and every plan that existed before the column)
 * or once for each beneficiary the assignment covers (`per_member`).
 *
 * The one place the vocabulary, a request's value and the number of fees an assignment owes are
 * decided. The scope is frozen onto the plan snapshot (`plan_snapshots.membership_fee_scope`), so
 * an assignment is charged by its own snapshot's scope and a later edit of the Plan moves nothing.
 * The billing engine multiplies the Membership Fee line by `membershipFeeUnits()` and nowhere else
 * does: a second multiplication in a pricing or display path is the defect #2800 describes.
 *
 * A new scope goes in three places: this list, the two CHECKs of migration 422
 * (`chk_membership_plans_fee_scope`, `chk_plan_snapshots_fee_scope`) and the admin's mirror
 * (`apps/admin/src/lib/membershipFeeScope.ts`).
 */

export const MEMBERSHIP_FEE_SCOPES = ['per_member', 'per_family'] as const;
export type MembershipFeeScope = typeof MEMBERSHIP_FEE_SCOPES[number];

/** What a plan and its snapshot hold unless somebody chose otherwise (#2834 §5). */
export const DEFAULT_MEMBERSHIP_FEE_SCOPE: MembershipFeeScope = 'per_family';

export function isMembershipFeeScope(value: unknown): value is MembershipFeeScope {
  return typeof value === 'string' && (MEMBERSHIP_FEE_SCOPES as readonly string[]).includes(value);
}

/** A stored value read back: anything unrecognised reads as the default (one fee per assignment). */
export function toMembershipFeeScope(value: unknown): MembershipFeeScope {
  return isMembershipFeeScope(value) ? value : DEFAULT_MEMBERSHIP_FEE_SCOPE;
}

export type MembershipFeeScopeInput =
  | { kind: 'absent' }
  | { kind: 'value'; value: MembershipFeeScope }
  | { kind: 'error'; error: string };

/**
 * A request's `membership_fee_scope`: not mentioned keeps what is stored, a known value sets it,
 * anything else (null included — the column has no "unset") is a 400, never a coercion.
 */
export function parseMembershipFeeScopeInput(body: unknown): MembershipFeeScopeInput {
  if (body == null || typeof body !== 'object' || !('membership_fee_scope' in body)) return { kind: 'absent' };
  const raw = (body as Record<string, unknown>).membership_fee_scope;
  if (raw === undefined) return { kind: 'absent' };
  if (isMembershipFeeScope(raw)) return { kind: 'value', value: raw };
  return { kind: 'error', error: `membership_fee_scope must be one of: ${MEMBERSHIP_FEE_SCOPES.join(', ')}` };
}

/**
 * How many Membership Fees an assignment owes per cycle: one per beneficiary for `per_member`
 * (never fewer than one, so a plan whose payer covers nobody still owes its fee), one otherwise.
 */
export function membershipFeeUnits(scope: MembershipFeeScope, beneficiaries: number): number {
  if (scope !== 'per_member') return 1;
  const n = Math.trunc(Number(beneficiaries));
  return Number.isFinite(n) && n > 1 ? n : 1;
}

/**
 * The same answer in SQL, for a plan snapshot aliased `s`: the snapshot's own scope and its own
 * `plan_snapshot_beneficiaries` rows. A NULL snapshot (no alias match) answers 1.
 */
export const membershipFeeUnitsSql = (s = 's') =>
  `(CASE WHEN ${s}.membership_fee_scope = 'per_member'
         THEN GREATEST(1, (SELECT COUNT(*) FROM plan_snapshot_beneficiaries fsb WHERE fsb.plan_snapshot_id = ${s}.id))
         ELSE 1 END)`;
