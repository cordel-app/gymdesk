/**
 * #2681 — a Member whose stored Access Rights are `revoked` (#1238) cannot use
 * the Members App, and this module is the one place that decides it.
 *
 * Only the **stored** value counts: `to_be_reviewed` is derived from payments
 * (`deriveAccessRights()`) and never blocks, and neither does a Membership Plan
 * or Payment Status. The check runs in `tenantContext` on every request made as
 * the `member` role (a member's own session or a superadmin impersonating one),
 * so a revocation applies to the next request of a session already open, and
 * a grant applies just as fast. Nothing is stored about the block itself: the
 * Clerk account, the member row and its business data are left alone.
 */

import { toMemberPreferredLocale } from './memberPreferredLocale';

export const MEMBER_ACCESS_REVOKED_CODE = 'member_access_revoked';

/** `true` only for the stored staff decision `revoked`. */
export function isMemberAccessRevoked(storedAccessRights: unknown): boolean {
  return storedAccessRights === 'revoked';
}

/**
 * Requests a revoked member may still make. Removing this device's push token
 * is part of signing out (`unregisterPushToken()` runs before `signOut()`,
 * #1073/#1282): refusing it would keep sending the member's alerts to a handset
 * whose owner can no longer open the app. It exposes no data.
 */
export function isAllowedWhileRevoked(method: string, path: string): boolean {
  return method.toUpperCase() === 'DELETE' && /^\/me\/devices\/[^/]+\/?$/.test(path);
}

export interface MemberAccessRevokedBody {
  error: string;
  code: typeof MEMBER_ACCESS_REVOKED_CODE;
  gym_name: string | null;
  /** The member's own language, so the screen is shown in it (and only it). */
  preferred_locale: string | null;
}

/** The `403` a revoked member's request is answered with. */
export function memberAccessRevokedBody(gymName: unknown, preferredLocale: unknown): MemberAccessRevokedBody {
  return {
    error: 'Your access to the Members App has been revoked',
    code: MEMBER_ACCESS_REVOKED_CODE,
    gym_name: typeof gymName === 'string' && gymName.trim() !== '' ? gymName : null,
    preferred_locale: toMemberPreferredLocale(preferredLocale),
  };
}
