/**
 * #1282 — what the avatar menu in the top bar offers, and where a logout lands.
 * #3156 — and the Family section under Profile.
 *
 * Pure, like `native.ts` and `bookingCancellation.ts`: no React, no Clerk, no
 * `t()`, so every answer is assertable without a browser. The component
 * (`components/MemberUserMenu.tsx`) draws; `lib/memberLogout.ts` performs.
 */

export type UserMenuItem = 'profile' | 'family' | 'logout';

/** A member of the caller's Family as `GET /me/family` reports them. */
export interface FamilyMenuMember {
  member_id: number;
  name: string;
  is_owner: boolean;
  image_url: string | null;
  image_thumbnail_url: string | null;
  modified_at?: string | null;
}

/**
 * The entries, in order (#3156: Profile, then the Family section, then Log out;
 * the signed-in email is no longer shown). A superadmin impersonating a member
 * sees the same menu a member does: Log out there ends the superadmin's own
 * session (the member is a header, not a session) and is what they expect to
 * find under the avatar. The dialog behind it ends and audits the impersonation
 * first. The Family section is drawn only when `familySectionMembers()` has
 * someone to list.
 */
export function userMenuItems(): UserMenuItem[] {
  return ['profile', 'family', 'logout'];
}

/**
 * The members the Family section lists, in the API's order (owner first, then
 * alphabetically). An unreadable answer lists nobody, so the section is absent
 * rather than broken.
 */
export function familySectionMembers(body: unknown): FamilyMenuMember[] {
  const members = (body as { members?: unknown } | null)?.members;
  if (!Array.isArray(members)) return [];
  return members.filter((m): m is FamilyMenuMember =>
    !!m && typeof m === 'object' && Number.isInteger((m as FamilyMenuMember).member_id)
    && typeof (m as FamilyMenuMember).name === 'string');
}

/** The 1080 × 1080 master the enlarged preview shows (never the thumbnail); null = nothing to enlarge. */
export function familyMemberPreviewSrc(m: Pick<FamilyMenuMember, 'image_url'>): string | null {
  return m.image_url && m.image_url.trim() ? m.image_url : null;
}

/** Where a logged-out member lands: the sign-in page of the locale they were using. */
export function signInPath(locale: string): string {
  return `/${locale}/sign-in`;
}
