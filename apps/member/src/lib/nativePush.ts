'use client';

import { deviceRegistrationBody, nativePlatform } from './native';

/**
 * #1073 (mobile app WP2) — registering and unregistering this device for push.
 *
 * `POST /me/devices` and `DELETE /me/devices/:token` are WP1's (#1072); what
 * lives here is the client half of the lifecycle that calls them, in one place
 * because the two halves have to agree about the one thing neither endpoint
 * stores for us: **which token this installation last registered**.
 *
 * Three of its answers are the rule rather than the implementation.
 *
 * **The token is remembered locally, and only so it can be removed.** The
 * registration itself is idempotent — the API's upsert refreshes `last_seen_at`
 * and re-points `gym_id`/`member_id` (migration 221) — so re-registering costs
 * nothing and the cache is never consulted to *skip* a registration. It exists
 * because `DELETE /me/devices/:token` names the token in its path and the
 * plugin's `registration` event has long since fired by the time somebody signs
 * out. `localStorage` rather than memory for the same reason: the sign-out may
 * happen on a later page load than the registration.
 *
 * **Unregistering happens before the session ends, never after.** The delete is
 * authenticated as the member whose device it is, so a sign-out has to remove the
 * token *first* — once Clerk has cleared the session there is no token to call
 * with, and a client that tried would be asking the API to trust a path
 * parameter. `unregisterPushToken()` is therefore called by the sign-out path
 * rather than by a listener on `isSignedIn`.
 *
 * **Neither half ever rejects.** Push is a courtesy copy of a
 * `member_notifications` row and never a condition of it (CLAUDE.md, #1072): a
 * member whose registration fails still has every alert in the app, so a failed
 * call must not take a sign-out, a page or a form down with it.
 */

/** Where this installation's last registered token is kept. Scoped by name, not
 * by member: a shared handset holds one token, and whoever signed in last owns
 * it — which is the same rule the API's global `UNIQUE (platform, token)` states.
 */
const PUSH_TOKEN_KEY = 'nativePushToken';

export function rememberPushToken(token: string): void {
  try {
    localStorage.setItem(PUSH_TOKEN_KEY, token);
  } catch {
    // Private mode, cleared site data, a WebView with storage blocked: the
    // registration still stands, only the later removal is lost.
  }
}

export function rememberedPushToken(): string | null {
  try {
    const stored = localStorage.getItem(PUSH_TOKEN_KEY);
    return stored && stored.trim() ? stored : null;
  } catch {
    return null;
  }
}

export function forgetPushToken(): void {
  try {
    localStorage.removeItem(PUSH_TOKEN_KEY);
  } catch {
    /* see rememberPushToken */
  }
}

type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

/**
 * Register this device's FCM token with the signed-in member.
 *
 * Answers whether it was sent, which is what the caller logs or ignores — there
 * is nothing for a member to do about a failure, and nothing to show them.
 */
export async function registerPushToken(apiFetch: ApiFetch, token: string, appId?: string | null): Promise<boolean> {
  const body = deviceRegistrationBody(nativePlatform(), token, appId);
  if (!body) return false;
  try {
    await apiFetch('/me/devices', { method: 'POST', body: JSON.stringify(body) });
    rememberPushToken(body.token);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove this device's token, before the session that may delete it ends.
 *
 * The local record is dropped either way: a token this installation is no longer
 * registering under is of no use to a later sign-out, and the row it points at is
 * taken over by the next member who signs in on the handset (the API's upsert) or
 * deleted by FCM's own `UNREGISTERED` answer when the app goes away.
 */
export async function unregisterPushToken(apiFetch: ApiFetch): Promise<boolean> {
  const token = rememberedPushToken();
  forgetPushToken();
  if (!token) return false;
  try {
    await apiFetch(`/me/devices/${encodeURIComponent(token)}`, { method: 'DELETE' });
    return true;
  } catch {
    return false;
  }
}
