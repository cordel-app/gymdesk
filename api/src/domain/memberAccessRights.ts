/**
 * A Member's Access Rights (#1238): informational state shown in the Member
 * header, independent of Membership Plan Status and Payment Status.
 *
 * Only `granted` / `revoked` are stored (a staff decision). `to_be_reviewed`
 * is derived: a stored `granted` with any payment problem across the Member's
 * billable concepts (#1235's worst Payment Status being failed or expired).
 * A stored `revoked` is never changed by payments, and cancelling a plan never
 * changes access.
 */
export const STORED_ACCESS_RIGHTS = ['granted', 'revoked'] as const;
export type StoredAccessRights = (typeof STORED_ACCESS_RIGHTS)[number];
export type AccessRights = StoredAccessRights | 'to_be_reviewed';

const PAYMENT_PROBLEM_STATUSES = ['failed', 'expired'];

export function isStoredAccessRights(v: unknown): v is StoredAccessRights {
  return typeof v === 'string' && (STORED_ACCESS_RIGHTS as readonly string[]).includes(v);
}

export function deriveAccessRights(stored: unknown, paymentStatus: string | null | undefined): AccessRights {
  if (stored === 'revoked') return 'revoked';
  if (paymentStatus && PAYMENT_PROBLEM_STATUSES.includes(paymentStatus)) return 'to_be_reviewed';
  return 'granted';
}
