/**
 * #643: request locale resolution.
 *
 * Translated *UI labels* live in each app's `locales/base/{en,es,ca}.json`.
 * Translated *data* (currently Nutrition Library item names) lives in the DB
 * and therefore has to be resolved server-side, which means the API needs to
 * know which language the caller is rendering in.
 *
 * Both apps send `x-locale` (from next-intl's `useLocale()`); `Accept-Language`
 * is honoured as a fallback so non-browser callers get something sensible.
 * Anything unrecognised resolves to the base locale, which is also the value
 * every translated column falls back to when a locale has no row.
 */

/** A locale that passed the allowlist — safe to interpolate into SQL. */
export type SupportedLocale = string & { readonly __brand: 'SupportedLocale' };

// Locales are BCP-47 primary subtags (optionally with subtags): letters, digits
// and hyphens only. Enforced at load time so a malformed env value can never
// reach `localizedNameExpr`'s SQL literal, whatever it contains.
const LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

function parseConfiguredLocales(): string[] {
  const raw = process.env.SUPPORTED_LOCALES ?? 'en,es,ca';
  const parsed = raw
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => LOCALE_PATTERN.test(l));
  // An env var that parses to nothing usable would silently disable
  // translations; fail loudly at boot instead.
  if (parsed.length === 0) {
    throw new Error(`SUPPORTED_LOCALES contains no valid locale: ${JSON.stringify(raw)}`);
  }
  return Array.from(new Set(parsed));
}

/** Every locale the API will resolve to, e.g. ['en', 'es', 'ca']. */
export const SUPPORTED_LOCALES: SupportedLocale[] = parseConfiguredLocales() as SupportedLocale[];

/**
 * The language `nutrition_library_items.name` (and every other base column) is
 * written in, and the fallback when a locale has no translation row.
 */
export const BASE_LOCALE: SupportedLocale = (() => {
  const configured = (process.env.DEFAULT_LOCALE ?? 'en').trim().toLowerCase();
  if (SUPPORTED_LOCALES.includes(configured as SupportedLocale)) return configured as SupportedLocale;
  return SUPPORTED_LOCALES[0];
})();

/** Locales that need a translation row — everything except the base language. */
export const TRANSLATABLE_LOCALES: SupportedLocale[] = SUPPORTED_LOCALES.filter((l) => l !== BASE_LOCALE);

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && SUPPORTED_LOCALES.includes(value.toLowerCase() as SupportedLocale);
}

/**
 * Narrow an arbitrary tag to a supported locale, or null. `es-ES` falls back to
 * `es` so a browser's regional tag still matches.
 */
export function normalizeLocale(value: unknown): SupportedLocale | null {
  if (typeof value !== 'string') return null;
  const tag = value.trim().toLowerCase();
  if (!tag) return null;
  if (isSupportedLocale(tag)) return tag as SupportedLocale;
  const primary = tag.split('-')[0];
  return isSupportedLocale(primary) ? (primary as SupportedLocale) : null;
}

/** First acceptable tag of an `Accept-Language` header, in q-value order. */
function fromAcceptLanguage(header: string): SupportedLocale | null {
  const candidates = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='));
      const weight = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0 };
    })
    .filter((c) => c.tag && c.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate.tag);
    if (locale) return locale;
  }
  return null;
}

/**
 * The locale to render this request's data in: `x-locale`, else
 * `Accept-Language`, else the base locale. Never throws and never returns a
 * value outside {@link SUPPORTED_LOCALES}.
 */
export function getRequestLocale(req: { headers?: Record<string, unknown> }): SupportedLocale {
  const headers = req.headers ?? {};

  const explicit = headers['x-locale'];
  const fromHeader = normalizeLocale(Array.isArray(explicit) ? explicit[0] : explicit);
  if (fromHeader) return fromHeader;

  const accept = headers['accept-language'];
  const acceptValue = Array.isArray(accept) ? accept[0] : accept;
  if (typeof acceptValue === 'string') {
    const negotiated = fromAcceptLanguage(acceptValue);
    if (negotiated) return negotiated;
  }

  return BASE_LOCALE;
}
