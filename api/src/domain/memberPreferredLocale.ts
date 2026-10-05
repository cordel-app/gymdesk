// #1039 — a Member's **default language** for the Members App: the one place
// that decides what `members.preferred_locale` (migration 220) may hold and how
// a request's value is judged.
//
//   My profile
//   LANGUAGE
//   [ Català ▾ ]
//
// reads "render the whole Members App in Catalan for me, on every device, until
// I say otherwise".
//
// **There is no second language system** (§2, §9). Which locales exist is
// `SUPPORTED_LOCALES` in `api/src/infra/locale.ts` (#643) — an env-configured
// allowlist, pattern-checked at boot — and this module adds no list of its own:
// it reuses that one's `normalizeLocale()`, which also folds a regional tag
// (`es-ES` → `es`) and, crucially, returns **the allowlist's own string** rather
// than the caller's. What is stored is therefore provably one of the configured
// locales (§10), as a matter of data flow rather than of an equality check
// having been done correctly.
//
// It is also why there is no CHECK on the column (migration 220's header): a
// deployment that configures a fourth locale would otherwise store a value the
// application accepts and the database refuses.
//
// Pure — no DB, no HTTP (CLAUDE.md).

import { normalizeLocale, SupportedLocale } from '../infra/locale';

/**
 * What a `PATCH /me/profile` should do with the `preferred_locale` field, and
 * the three answers are the ones every partial write in this codebase draws
 * (#896, #918, #980 stage 2) with one deliberate difference:
 *
 *   `keep`  — the field was not **mentioned**. The member is editing their
 *             phone number, and a payload that says nothing about the language
 *             must not reset it. Every client written before this ticket sends
 *             exactly that.
 *   `clear` — an explicit `null` (or `''`): "no preference", which is what the
 *             selector's own default option means and what §3/§11 say a member
 *             without one gets — the application's current default, resolved per
 *             request as it always was. This is the difference: `null` here is a
 *             value, not an absence, because the column's NULL *means*
 *             something.
 *   `set`   — a supported locale, stored as the allowlist's own string.
 *   `error` — anything else, which is a 400 and never a coercion: silently
 *             storing `en` for a member who asked for `fr` would tell them the
 *             choice was saved.
 */
export type MemberPreferredLocaleInput =
  | { keep: true; clear?: undefined; locale?: undefined; error?: undefined }
  | { keep?: undefined; clear: true; locale?: undefined; error?: undefined }
  | { keep?: undefined; clear?: undefined; locale: SupportedLocale; error?: undefined }
  | { keep?: undefined; clear?: undefined; locale?: undefined; error: string };

export function parseMemberPreferredLocaleInput(body: unknown): MemberPreferredLocaleInput {
  const raw = (body as { preferred_locale?: unknown } | null | undefined)?.preferred_locale;
  if (raw === undefined) return { keep: true };
  if (raw === null || raw === '') return { clear: true };
  const locale = normalizeLocale(raw);
  if (locale) return { locale };
  return { error: 'preferred_locale is not a supported language' };
}

/**
 * A **stored** column value, narrowed for a read. A locale that is no longer
 * configured — a deployment that dropped one from `SUPPORTED_LOCALES` — reads
 * back as `null`, i.e. "no preference", rather than as itself: the Members App
 * has no route segment to send that member to, so reporting it would point the
 * one mechanism that applies the preference at a locale that cannot render.
 * The column is left exactly as it is, so re-adding the locale brings the
 * member's choice back; this is a read-time answer, not a correction.
 */
export function toMemberPreferredLocale(value: unknown): SupportedLocale | null {
  return normalizeLocale(value);
}
