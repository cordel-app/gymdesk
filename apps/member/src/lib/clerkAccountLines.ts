/**
 * #1234 — the Clerk Status and Clerk Invitation lines of a Member's account.
 *
 * Pure: it picks the locale key and the date, and resolves no `t()`. The two
 * lines answer different questions and neither reads membership, payment or
 * eligibility: Status is whether a Clerk account is linked (`enrolled`), and
 * Invitation is whether one is pending. Dates are stored history, so a missing
 * one (a member who linked before the column existed) renders the line without
 * a date rather than inventing one.
 */
export interface ClerkAccountFields {
  clerk_user_id?: string | null;
  enrolled?: boolean;
  has_pending_invitation?: boolean;
  invited_at?: string | null;
  enrolled_at?: string | null;
}

export interface ClerkAccountLine {
  /** Locale key under the caller's namespace. */
  key: string;
  /** Pre-formatted date to interpolate as `{date}`, or null when the key takes none. */
  date: string | null;
}

export function formatClerkDate(value: string | null | undefined, locale: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function clerkStatusLine(f: ClerkAccountFields, locale: string): ClerkAccountLine {
  const enrolled = f.enrolled ?? !!f.clerk_user_id;
  if (!enrolled) return { key: 'clerk_status_not_enrolled', date: null };
  const date = formatClerkDate(f.enrolled_at, locale);
  return { key: date ? 'clerk_status_enrolled_on' : 'clerk_status_enrolled', date };
}

export function clerkInvitationLine(f: ClerkAccountFields, locale: string): ClerkAccountLine {
  if (!f.has_pending_invitation) return { key: 'clerk_invitation_none', date: null };
  const date = formatClerkDate(f.invited_at, locale);
  return { key: date ? 'clerk_invitation_invited_on' : 'clerk_invitation_invited', date };
}
