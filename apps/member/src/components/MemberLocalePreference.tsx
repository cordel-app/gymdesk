'use client';

import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { preferredLocalePath } from '@/lib/memberLocale';

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
 * **Not while impersonating.** The preference belongs to the member; a
 * superadmin looking at a member's app through impersonation picked their own
 * locale in the URL, and bouncing them into a language they may not read is a
 * staff-facing surprise the ticket never asks for. The member's own session is
 * unaffected, since `isImpersonating` is false there.
 */
export function MemberLocalePreference() {
  const locale = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { member, loading } = useApp();
  const { isImpersonating } = useImpersonation();

  useEffect(() => {
    if (loading || isImpersonating || !member) return;
    const target = preferredLocalePath(pathname ?? '/', locale, member.preferred_locale);
    if (!target) return;
    const query = searchParams?.toString();
    router.replace(query ? `${target}?${query}` : target);
  }, [loading, isImpersonating, member, pathname, locale, searchParams, router]);

  return null;
}
