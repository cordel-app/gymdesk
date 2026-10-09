/**
 * #1076 follow-up (mobile app WP4) — "Open in the app" on the invitation page.
 *
 * Clerk's invitation email does not link to this domain: its button is Clerk's
 * own ticket-accept URL, which redirects to `/{locale}/link?…` afterwards. iOS
 * and Android hand a tapped link to the app only when the URL tapped is on the
 * app's domain, so the universal link / App Links of WP4 never fire for it and
 * the invitation opens in the browser. This is the member's way across: the page
 * offers the app's own **custom scheme**, which a deliberate tap opens wherever
 * the app is installed.
 *
 * Pure, for `lib/native.ts`'s reason. Three answers are the rule rather than the
 * implementation.
 *
 * **The offer comes before the ticket is redeemed.** An invitation ticket is
 * single-use: if the page redeemed it in the browser first, the app would open
 * onto a spent invitation. So the offer replaces the automatic redeem, and
 * "Continue in the browser" is what runs it — which is also why this never
 * strands a member whose app is not installed.
 *
 * **The scheme is configuration, never a literal** (design rule 1):
 * `NEXT_PUBLIC_MOBILE_APP_SCHEME`, the profile's `customUrlScheme`. Unset, there
 * is no offer at all and the page behaves exactly as before.
 *
 * **Only a phone's browser is offered it.** Inside the app the link is already
 * handled (`appUrlOpen`), and on a desktop there is no app to open.
 */

/** A phone or tablet browser, by the platform words both stores' devices carry. */
export function isMobileBrowser(userAgent: string | null | undefined): boolean {
  return typeof userAgent === 'string' && /iPhone|iPad|iPod|Android/i.test(userAgent);
}

export interface OpenInAppInput {
  /** `isNative()` — inside the shell the link is already the app's. */
  native: boolean;
  userAgent: string | null | undefined;
  /** `NEXT_PUBLIC_MOBILE_APP_SCHEME`, or nothing. */
  scheme: string | null | undefined;
  /** An invitation carries a ticket; without one there is nothing to hand over. */
  hasTicket: boolean;
}

/** The scheme to open, or `null` when the offer must not be shown. */
export function openInAppScheme(input: OpenInAppInput): string | null {
  const scheme = (input.scheme ?? '').trim();
  // A scheme is `[a-z][a-z0-9+.-]*` (RFC 3986): anything else is configuration
  // that would build a URL the browser reads as a path, not an app.
  if (!scheme || !/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return null;
  if (input.native || !input.hasTicket) return null;
  return isMobileBrowser(input.userAgent) ? scheme : null;
}

/**
 * The URL that opens this invitation in the app: the app's scheme in place of
 * the origin, the locale as the host (`appUrlOpenPath()` reads that shape) and
 * the page's own query — `gym_id` and `__clerk_ticket` — untouched.
 */
export function openInAppUrl(scheme: string, locale: string, search: string): string {
  const query = search.startsWith('?') || !search ? search : `?${search}`;
  return `${scheme}://${locale}/link${query}`;
}
