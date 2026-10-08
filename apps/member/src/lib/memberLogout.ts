'use client';

import { unregisterPushToken } from './nativePush';
import { signInPath } from './memberUserMenu';

type ApiFetch = Parameters<typeof unregisterPushToken>[0];

/**
 * #1282 — log the member out, in the one order that works.
 *
 * The device's push token goes **before** the session does: the delete is
 * authenticated as the member whose device it is, so after `signOut()` there is
 * nothing to call it with and that member's alerts would keep arriving on this
 * handset (#1073). It is a no-op on the web and on a device that never
 * registered one, and a failure of it never blocks the logout. Clerk's own
 * redirect is replaced by a full navigation to the sign-in page, so no state
 * of the signed-out member survives in memory.
 */
export async function logoutMember(
  apiFetch: ApiFetch,
  signOut: (callback?: () => void) => Promise<unknown>,
  locale: string,
): Promise<void> {
  await unregisterPushToken(apiFetch);
  await signOut(() => window.location.replace(signInPath(locale)));
}
