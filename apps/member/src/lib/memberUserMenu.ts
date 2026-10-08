/**
 * #1282 — what the avatar menu in the top bar offers, and where a logout lands.
 *
 * Pure, like `native.ts` and `bookingCancellation.ts`: no React, no Clerk, no
 * `t()`, so both answers are assertable without a browser. The component
 * (`components/MemberUserMenu.tsx`) draws; `lib/memberLogout.ts` performs.
 */

export type UserMenuItem = 'profile' | 'logout';

/**
 * The entries, in order. A superadmin impersonating a member is signed in as
 * *themselves* (the impersonated member is a header, not a session), so a Log
 * out there would end the superadmin's own session rather than leave the
 * member; the impersonation banner already has the way out.
 */
export function userMenuItems(impersonating: boolean): UserMenuItem[] {
  return impersonating ? ['profile'] : ['profile', 'logout'];
}

/** Where a logged-out member lands: the sign-in page of the locale they were using. */
export function signInPath(locale: string): string {
  return `/${locale}/sign-in`;
}
