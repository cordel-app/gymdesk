/**
 * #1817 — Cordel → Base Professional Services: the pure rules.
 *
 * A Base Professional Service is a `professional_services` row with
 * `gym_id IS NULL`. Its `name` / `description` are the base-locale (English)
 * values and the fallback; every other product language is one row of
 * `professional_service_translations` (migration 296), CLAUDE.md's junction
 * shape for translated data. `max_capacity` is a property of the definition
 * only — nothing books, schedules or enforces against it yet.
 */

export const BASE_PS_NAME_MAX_LENGTH = 150;
export const BASE_PS_DESCRIPTION_MAX_LENGTH = 2000;
/** Largest value `max_capacity` (INT UNSIGNED) may hold without surprising anyone. */
export const BASE_PS_MAX_CAPACITY = 100000;

/** The non-base product languages a service is translated into (the base name is English). */
export const BASE_PS_TRANSLATION_LOCALES = ['es', 'ca'] as const;

export type BasePsTranslations = Record<string, { name: string; description: string | null }>;

/** `undefined` → keep, `null`/`''` → clear, a positive integer → set; anything else is a 400. */
export function parseMaxCapacity(value: unknown): { value: number | null } | { error: string } {
  if (value === null || value === '') return { value: null };
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isInteger(n) || n <= 0) return { error: 'max_capacity must be a positive integer' };
  if (n > BASE_PS_MAX_CAPACITY) return { error: `max_capacity must be at most ${BASE_PS_MAX_CAPACITY}` };
  return { value: n };
}

export function parseBaseName(value: unknown): { value: string } | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: 'name is required' };
  const name = value.trim();
  if (name.length > BASE_PS_NAME_MAX_LENGTH) return { error: `name must be at most ${BASE_PS_NAME_MAX_LENGTH} characters` };
  return { value: name };
}

export function parseBaseDescription(value: unknown): { value: string | null } | { error: string } {
  if (value === null || value === undefined || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'description must be a string' };
  const d = value.trim();
  if (d.length > BASE_PS_DESCRIPTION_MAX_LENGTH) return { error: `description must be at most ${BASE_PS_DESCRIPTION_MAX_LENGTH} characters` };
  return { value: d || null };
}

/**
 * Judges a `translations` map: an unknown locale is a 400 (never dropped
 * quietly) and a description is optional. A Base service must carry a name in
 * every locale (`requireAll`); a gym's own service (#2110) may leave a locale
 * out or blank, which falls back to the base text at read time.
 */
export function parsePsTranslations(
  value: unknown,
  opts: { requireAll: boolean },
): { value: BasePsTranslations } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'translations must be an object keyed by locale' };
  }
  const input = value as Record<string, any>;
  for (const key of Object.keys(input)) {
    if (!(BASE_PS_TRANSLATION_LOCALES as readonly string[]).includes(key)) {
      return { error: `Unsupported locale: ${key}` };
    }
  }
  const out: BasePsTranslations = {};
  for (const locale of BASE_PS_TRANSLATION_LOCALES) {
    const entry = input[locale];
    const blank = !entry || typeof entry !== 'object' || (typeof entry.name === 'string' && !entry.name.trim() && !entry.description);
    if (!opts.requireAll && blank) continue;
    if (!entry || typeof entry !== 'object') return { error: `translations.${locale}.name is required` };
    const name = parseBaseName(entry.name);
    if ('error' in name) return { error: `translations.${locale}.${name.error}` };
    const description = parseBaseDescription(entry.description);
    if ('error' in description) return { error: `translations.${locale}.${description.error}` };
    out[locale] = { name: name.value, description: description.value };
  }
  return { value: out };
}

export function parseBasePsTranslations(value: unknown): { value: BasePsTranslations } | { error: string } {
  return parsePsTranslations(value, { requireAll: true });
}
