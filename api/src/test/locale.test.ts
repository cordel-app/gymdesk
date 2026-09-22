import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #643 — unit tests for request locale resolution and the localized-name SQL
 * expression. Pure functions over headers and env vars: no DB, no HTTP.
 *
 * `infra/locale` reads its env vars at module load, so every test that changes
 * the configuration re-imports the module after `vi.resetModules()`.
 */

const ENV_KEYS = ['SUPPORTED_LOCALES', 'DEFAULT_LOCALE'] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function req(headers: Record<string, string>) {
  return { headers };
}

describe('getRequestLocale()', () => {
  it('prefers the x-locale header', async () => {
    const { getRequestLocale } = await import('../infra/locale');
    expect(getRequestLocale(req({ 'x-locale': 'ca' }))).toBe('ca');
  });

  it('is case-insensitive and tolerates surrounding whitespace', async () => {
    const { getRequestLocale } = await import('../infra/locale');
    expect(getRequestLocale(req({ 'x-locale': ' ES ' }))).toBe('es');
  });

  it('falls back to a regional tag’s primary subtag', async () => {
    const { getRequestLocale } = await import('../infra/locale');
    expect(getRequestLocale(req({ 'x-locale': 'es-MX' }))).toBe('es');
  });

  it('falls back to the base locale for an unsupported language', async () => {
    const { getRequestLocale } = await import('../infra/locale');
    expect(getRequestLocale(req({ 'x-locale': 'de' }))).toBe('en');
  });

  it('falls back to the base locale when no headers are present', async () => {
    const { getRequestLocale } = await import('../infra/locale');
    expect(getRequestLocale({ headers: {} })).toBe('en');
    expect(getRequestLocale({})).toBe('en');
  });

  it('negotiates Accept-Language when x-locale is absent', async () => {
    const { getRequestLocale } = await import('../infra/locale');
    expect(getRequestLocale(req({ 'accept-language': 'ca-ES,ca;q=0.9,en;q=0.5' }))).toBe('ca');
  });

  it('honours Accept-Language q-values over header order', async () => {
    const { getRequestLocale } = await import('../infra/locale');
    expect(getRequestLocale(req({ 'accept-language': 'en;q=0.3, es;q=0.9' }))).toBe('es');
  });

  it('skips Accept-Language entries the API does not support', async () => {
    const { getRequestLocale } = await import('../infra/locale');
    expect(getRequestLocale(req({ 'accept-language': 'de,fr;q=0.8,es;q=0.2' }))).toBe('es');
  });

  it('ignores Accept-Language when x-locale is usable', async () => {
    const { getRequestLocale } = await import('../infra/locale');
    expect(getRequestLocale(req({ 'x-locale': 'es', 'accept-language': 'ca' }))).toBe('es');
  });

  // A header an attacker controls must never widen the allowlist — this is what
  // makes interpolating the resolved locale into SQL safe.
  it('rejects an injection attempt in x-locale and returns the base locale', async () => {
    const { getRequestLocale } = await import('../infra/locale');
    expect(getRequestLocale(req({ 'x-locale': "es' OR '1'='1" }))).toBe('en');
  });
});

describe('locale configuration', () => {
  it('reads the allowlist and base locale from the environment', async () => {
    process.env.SUPPORTED_LOCALES = 'en,es,ca,fr';
    process.env.DEFAULT_LOCALE = 'es';
    const { SUPPORTED_LOCALES, BASE_LOCALE, TRANSLATABLE_LOCALES, getRequestLocale } = await import('../infra/locale');

    expect(SUPPORTED_LOCALES).toEqual(['en', 'es', 'ca', 'fr']);
    expect(BASE_LOCALE).toBe('es');
    expect(TRANSLATABLE_LOCALES).toEqual(['en', 'ca', 'fr']);
    expect(getRequestLocale(req({ 'x-locale': 'fr' }))).toBe('fr');
    expect(getRequestLocale(req({ 'x-locale': 'de' }))).toBe('es');
  });

  it('drops malformed entries from SUPPORTED_LOCALES', async () => {
    process.env.SUPPORTED_LOCALES = "en, es, ');DROP TABLE gyms;--";
    const { SUPPORTED_LOCALES } = await import('../infra/locale');
    expect(SUPPORTED_LOCALES).toEqual(['en', 'es']);
  });

  it('throws when SUPPORTED_LOCALES has no usable entry', async () => {
    process.env.SUPPORTED_LOCALES = '!!!, ???';
    await expect(import('../infra/locale')).rejects.toThrow(/SUPPORTED_LOCALES/);
  });

  it('falls back to the first supported locale when DEFAULT_LOCALE is not in the allowlist', async () => {
    process.env.SUPPORTED_LOCALES = 'ca,es';
    process.env.DEFAULT_LOCALE = 'en';
    const { BASE_LOCALE } = await import('../infra/locale');
    expect(BASE_LOCALE).toBe('ca');
  });
});

describe('localizedNameSql()', () => {
  it('is a plain column reference for the base locale (no join cost)', async () => {
    const { localizedNameSql } = await import('../domain/nutritionLibrary');
    const { BASE_LOCALE } = await import('../infra/locale');
    expect(localizedNameSql('nli', BASE_LOCALE)).toBe('nli.name');
  });

  it('falls back to the base name for a translated locale', async () => {
    const { localizedNameSql } = await import('../domain/nutritionLibrary');
    const sql = localizedNameSql('nli', 'ca' as any);
    expect(sql).toContain('COALESCE');
    expect(sql).toContain("nlit.locale = 'ca'");
    expect(sql).toContain('nlit.item_id = nli.id');
    expect(sql.trimEnd().endsWith('nli.name)')).toBe(true);
  });

  it('honours the table alias it is given', async () => {
    const { localizedNameSql } = await import('../domain/nutritionLibrary');
    expect(localizedNameSql('food', 'es' as any)).toContain('nlit.item_id = food.id');
  });

  it('appends the requested output alias', async () => {
    const { localizedNameExpr } = await import('../domain/nutritionLibrary');
    expect(localizedNameExpr('nli', 'es' as any, 'item_name')).toMatch(/ AS item_name$/);
  });
});

describe('validateTranslations()', () => {
  it('accepts an object of supported non-base locales', async () => {
    const { validateTranslations } = await import('../domain/nutritionLibrary');
    expect(validateTranslations({ es: 'Pollo', ca: 'Pollastre' })).toBeNull();
    expect(validateTranslations({})).toBeNull();
  });

  it('rejects a non-object payload', async () => {
    const { validateTranslations } = await import('../domain/nutritionLibrary');
    expect(validateTranslations(['Pollo'])).toMatchObject({ error: expect.stringContaining('object') });
    expect(validateTranslations('Pollo')).toMatchObject({ error: expect.stringContaining('object') });
    expect(validateTranslations(null)).toMatchObject({ error: expect.stringContaining('object') });
  });

  it('rejects an unsupported locale rather than dropping it silently', async () => {
    const { validateTranslations } = await import('../domain/nutritionLibrary');
    expect(validateTranslations({ de: 'Hähnchen' })).toMatchObject({ error: expect.stringContaining('de') });
  });

  it('rejects the base locale — that is the item’s own name column', async () => {
    const { validateTranslations } = await import('../domain/nutritionLibrary');
    expect(validateTranslations({ en: 'Chicken' })).toMatchObject({ error: expect.stringContaining('name') });
  });

  it('rejects a non-string name and one longer than the column', async () => {
    const { validateTranslations } = await import('../domain/nutritionLibrary');
    expect(validateTranslations({ es: 42 })).toMatchObject({ error: expect.stringContaining('string') });
    expect(validateTranslations({ es: 'x'.repeat(256) })).toMatchObject({ error: expect.stringContaining('255') });
  });
});
