/**
 * #2681 — the Members App's half of "a revoked member cannot use the app".
 *
 * The API decides (`api/src/domain/memberAccessRevocation.ts`): every request a
 * revoked member makes answers `403 { code: 'member_access_revoked', gym_name,
 * preferred_locale }`. This module only recognises that answer, so the app can
 * replace every screen with the revoked-access message. Pure: no React, no `t()`.
 */

export const MEMBER_ACCESS_REVOKED_CODE = 'member_access_revoked';

/** Fired on `window` by `apiFetch` when a request is refused as revoked. */
export const MEMBER_ACCESS_REVOKED_EVENT = 'gd:member-access-revoked';

export interface MemberAccessRevocation {
  /** The gym's own name, shown in the message; `null` when the API had none. */
  gymName: string | null;
  /** The member's profile language, which the message is shown in. */
  preferredLocale: string | null;
}

/** The revocation an API answer carries, or `null` for any other answer. */
export function readAccessRevocation(status: number, body: unknown): MemberAccessRevocation | null {
  if (status !== 403 || !body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.code !== MEMBER_ACCESS_REVOKED_CODE) return null;
  return {
    gymName: typeof b.gym_name === 'string' && b.gym_name.trim() !== '' ? b.gym_name : null,
    preferredLocale: typeof b.preferred_locale === 'string' ? b.preferred_locale : null,
  };
}

/** Which message key the screen shows: the gym's name when known, else a generic one. */
export function accessRevokedMessageKey(revocation: MemberAccessRevocation): 'message' | 'message_no_gym' {
  return revocation.gymName ? 'message' : 'message_no_gym';
}
