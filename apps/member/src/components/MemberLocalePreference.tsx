'use client';

import { useEffect } from 'react';
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
export function MemberLocalePreference() {
  const locale = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { member, loading } = useApp();
  const { isImpersonating } = useImpersonation();

  useEffect(() => {
    if (loading) return;
    const go = (target: string) => {
      const query = searchParams?.toString();
      router.replace(query ? `${target}?${query}` : target);
    };

    if (!isImpersonating) {
      // Back from an impersonation: return to the locale the superadmin was in.
      const saved = readReturnLocale();
      if (saved) {
        clearReturnLocale();
        const back = preferredLocalePath(pathname ?? '/', locale, saved);
        if (back) { go(back); return; }
      }
    }

    if (!member) return;
    // A member with no preference (or one this app cannot render) sees the app's
    // default language, not the superadmin's: impersonating is to see what they
    // see. Their own session keeps following the browser, so nothing is forced there.
    const preferred = isImpersonating && !isMemberLocale(member.preferred_locale)
      ? DEFAULT_MEMBER_LOCALE
      : member.preferred_locale;
    const target = preferredLocalePath(pathname ?? '/', locale, preferred);
    if (!target) return;
    if (isImpersonating) rememberReturnLocale(locale);
    go(target);
  }, [loading, isImpersonating, member, pathname, locale, searchParams, router]);

  return null;
}

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
