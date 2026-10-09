/**
 * #1282 — what the avatar menu in the top bar offers, and where a logout lands.
 *
 * Pure, like `native.ts` and `bookingCancellation.ts`: no React, no Clerk, no
 * `t()`, so both answers are assertable without a browser. The component
 * (`components/MemberUserMenu.tsx`) draws; `lib/memberLogout.ts` performs.
 */

export type UserMenuItem = 'profile' | 'logout';

/**
 * The entries, in order. A superadmin impersonating a member sees the same menu
 * a member does: Log out there ends the superadmin's own session (the member is
 * a header, not a session) and is what they expect to find under the avatar.
 * The dialog behind it ends and audits the impersonation first.
 */
export function userMenuItems(): UserMenuItem[] {
  return ['profile', 'logout'];
}

/** Where a logged-out member lands: the sign-in page of the locale they were using. */
export function signInPath(locale: string): string {
  return `/${locale}/sign-in`;
}
