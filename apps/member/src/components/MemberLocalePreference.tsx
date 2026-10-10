'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useLocale } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { DEFAULT_MEMBER_LOCALE, isMemberLocale, preferredLocalePath } from '@/lib/memberLocale';

/**
 * #1039 — the **one** place a member's stored default language is applied to
 * the Members App.
 *
 * Mounted once by the locale layout, inside `AppProvider`, so it covers every
 * section at once (§7: the dashboard, My Training Plan, My Bookings, Calendar,
 * My Nutrition, My Membership, My Profile, Alerts and everything they render) —
 * rather than each page or the selector doing its own switching, which is what
 * §5 forbids. It renders nothing.
 *
 * The locale of a page is its first URL segment, so "apply the preference" is
 * `router.replace()` onto the same page under that segment: next-intl then
 * resolves the messages, `<html lang>` follows, the layout picks the matching
 * Clerk localization, and `apiClient` sends it as `x-locale` for server-resolved
 * content. `replace` rather than `push` because the pre-switch URL is not a
 * place the member chose to be and should not be a Back target, and the decision
 * itself is `preferredLocalePath()`'s — including every case that answers
 * "stay put", so this cannot loop.
 *
 * **Impersonating applies the member's language too**, because the whole point of
 * impersonating is to see what the member sees (a text that does not fit, a key
 * that is not translated, a format) and none of that reproduces in the
 * superadmin's own language. The locale the superadmin came from is kept in
 * `sessionStorage` the first time the preference moves them and is restored
 * when the impersonation ends, so they are not left in the member's language.
 * A member with no preference is shown the app's default language while impersonated.
 * Nothing is stored for a member's own session, which never impersonates.
 */
export function MemberLocalePreference({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { member, loading } = useApp();
  const { isImpersonating } = useImpersonation();
  const [gaveUp, setGaveUp] = useState(false);

  // What, if anything, has to change language. Decided during render so the
  // page below can be held back for exactly as long as the switch is pending
  // (#1039): rendering the member's screens first in the wrong language and
  // then replacing the route is the flicker a superadmin saw on impersonating.
  // `loading` is true on the first client render, so this is null on both the
  // server and the first client pass and nothing mismatches on hydration.
  let pending: { target: string; kind: 'return' | 'preference' } | null = null;
  if (!loading) {
    if (!isImpersonating) {
      // Back from an impersonation: return to the locale the superadmin was in.
      const saved = readReturnLocale();
      const back = saved ? preferredLocalePath(pathname ?? '/', locale, saved) : null;
      if (back) pending = { target: back, kind: 'return' };
    }
    if (!pending && member) {
      // A member with no preference (or one this app cannot render) sees the app's
      // default language, not the superadmin's: impersonating is to see what they
      // see. Their own session keeps following the browser, so nothing is forced there.
      const preferred = isImpersonating && !isMemberLocale(member.preferred_locale)
        ? DEFAULT_MEMBER_LOCALE
        : member.preferred_locale;
      const target = preferredLocalePath(pathname ?? '/', locale, preferred);
      if (target) pending = { target, kind: 'preference' };
    }
  }

  const target = pending?.target ?? null;
  const kind = pending?.kind ?? null;

  useEffect(() => {
    if (!target) return;
    if (kind === 'return') clearReturnLocale();
    else if (isImpersonating) rememberReturnLocale(locale);
    const query = searchParams?.toString();
    router.replace(query ? `${target}?${query}` : target);
  }, [target, kind, isImpersonating, locale, searchParams, router]);

  // A switch that never lands must not leave the app blank.
  useEffect(() => {
    if (!target) { setGaveUp(false); return; }
    const timer = setTimeout(() => setGaveUp(true), SWITCH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [target]);

  return <>{target && !gaveUp ? null : children}</>;
}

/** How long the page is held back for a language switch before it is shown anyway. */
const SWITCH_TIMEOUT_MS = 3000;

const RETURN_LOCALE_KEY = 'impersonation_return_locale';

function readReturnLocale(): string | null {
  try { return sessionStorage.getItem(RETURN_LOCALE_KEY); } catch { return null; }
}
function clearReturnLocale(): void {
  try { sessionStorage.removeItem(RETURN_LOCALE_KEY); } catch {}
}
/** Kept once per impersonation: a second switch must not overwrite where they came from. */
function rememberReturnLocale(locale: string): void {
  try { if (!sessionStorage.getItem(RETURN_LOCALE_KEY)) sessionStorage.setItem(RETURN_LOCALE_KEY, locale); } catch {}
}
