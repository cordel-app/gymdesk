/**
 * #1039 — the Members App's languages, and the one rule that turns a member's
 * stored preference into the locale the app renders in.
 *
 * ## One language system (§2, §8)
 *
 * `MEMBER_LOCALES` is the app's own list, and it is **one** list: `middleware.ts`
 * hands it to next-intl's routing middleware, the My Profile selector offers it,
 * and `preferredLocalePath()` decides against it. The API has the matching
 * allowlist of its own (`SUPPORTED_LOCALES` in `api/src/infra/locale.ts`,
 * env-configured) and it is the one that *validates* a write — a browser list
 * cannot, since the member app is not the only client. What this module knows is
 * which locales this app has route segments and message files for, which is
 * exactly what deciding a redirect needs.
 *
 * ## The preference is applied in one place
 *
 * The locale of a Members App page *is* its first URL segment — that is how
 * next-intl resolves messages, how `<html lang>` is set, which Clerk
 * localization the layout picks, and what `apiClient` sends as `x-locale` for
 * server-resolved content (#643). So applying a stored preference can only mean
 * one thing: being on that locale's URL. `preferredLocalePath()` says when the
 * member is not, and `components/MemberLocalePreference.tsx` is the single
 * consumer — a page must not navigate on the preference itself, which is §5's
 * "avoid implementing a separate language-switching mechanism specifically for
 * My Profile".
 *
 * `null` (no stored preference) is deliberately **not** a redirect to the
 * default: a member without one keeps whatever locale they are browsing in, and
 * the app's own default applies only because next-intl already resolved it
 * (§3, §11).
 *
 * Pure — no React, no router, no `t()` call of its own.
 */

/**
 * The languages the Members App ships: route segments in `app/[locale]`,
 * message files in `locales/base/{en,es,ca}.json`, and Clerk localizations in
 * the locale layout. Adding one means adding all three, plus its
 * `profile.language_<code>` label in every locale file.
 *
 * The order is the order the selector offers.
 */
export const MEMBER_LOCALES = ['en', 'es', 'ca'] as const;

export type MemberLocale = (typeof MEMBER_LOCALES)[number];

/**
 * next-intl's `defaultLocale`: the locale a visitor with no cookie and no
 * matching `Accept-Language` is routed to. It is **not** a member's preference
 * and is never written to one — §3 forbids forcing a default into the column.
 */
export const DEFAULT_MEMBER_LOCALE: MemberLocale = 'en';

export function isMemberLocale(value: unknown): value is MemberLocale {
  return typeof value === 'string' && (MEMBER_LOCALES as readonly string[]).includes(value);
}

/**
 * What to call a language, resolved **before** `t()` is called and falling back
 * to the tag in upper case — next-intl has no `defaultValue` option and prints a
 * missing key verbatim, so a locale added to the list before its label exists
 * renders `FR` rather than `profile.language_fr` (CLAUDE.md). Mirrors the
 * admin's `lib/localeLabels.ts`, which does the same for its own namespace.
 */
export function memberLocaleLabel(locale: string, translate: (key: string) => string): string {
  const tag = locale.trim().toLowerCase();
  return isMemberLocale(tag) ? translate(`profile.language_${tag}`) : tag.toUpperCase();
}

/**
 * The same path under another locale. The locale is a Members App path's first
 * segment, so this swaps it when there is one and prefixes it when there is not
 * (`/` → `/es`); a trailing-segment-only path keeps everything after the
 * locale untouched, query and hash included — those are the caller's to append,
 * since this takes a pathname.
 */
export function localePath(pathname: string, locale: string): string {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.length > 0 && isMemberLocale(segments[0])) segments[0] = locale;
  else segments.unshift(locale);
  return `/${segments.join('/')}`;
}

/**
 * Where the member should be, given the locale they are on and the one they
 * have stored — or `null` for "stay put", which is the answer whenever:
 *
 *   - they have no stored preference (§3/§11: the app's default still applies,
 *     and writing it into the column is what §3 rules out);
 *   - the stored value is not one this app can render (a locale dropped from
 *     the deployment's `SUPPORTED_LOCALES`, or an API that grew one this app has
 *     no messages for) — redirecting there would 404 the segment or render raw
 *     keys, and the member keeps reading the app in the meantime;
 *   - they are already on it, which is the steady state and therefore the case
 *     that must not loop.
 */
export function preferredLocalePath(
  pathname: string,
  currentLocale: string,
  preferred: string | null | undefined,
): string | null {
  if (!preferred || !isMemberLocale(preferred)) return null;
  if (preferred === currentLocale) return null;
  return localePath(pathname, preferred);
}
