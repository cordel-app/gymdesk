/**
 * The application's languages, named in one place (#967).
 *
 * Which locales exist is the API's answer (`GET /exercises/locales`,
 * `GET /platform/exercises/lookups`, `GET /platform/nutrition-library/locales`) —
 * never a list in a component, which is what the ticket's closing "Important"
 * forbids. This module only says what to *call* one, and it is shared so the
 * Exercises editor and the Nutrition Library's translation inputs cannot label
 * the same locale two ways.
 *
 * The key is resolved **before** `t()` is called, falling back to the tag in
 * upper case: next-intl has no `defaultValue` option and prints a missing key
 * verbatim, so a locale added to `SUPPORTED_LOCALES` before its label exists
 * renders `FR` rather than `languages.fr` (CLAUDE.md).
 */
export const NAMED_LOCALES = ['en', 'es', 'ca'] as const;

export function localeLabel(locale: string, translate: (key: string) => string): string {
  const tag = locale.trim().toLowerCase();
  return (NAMED_LOCALES as readonly string[]).includes(tag)
    ? translate(`languages.${tag}`)
    : tag.toUpperCase();
}
