import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #967 — unit tests for multilingual exercise names: the SQL builders, the
 * payload validation and the migration they mirror. Pure functions over strings:
 * no DB, no HTTP.
 *
 * `infra/locale` reads its env vars at module load, so every test that changes
 * the configuration re-imports the module after `vi.resetModules()` — the same
 * shape `locale.test.ts` uses for #643.
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

const MIGRATION = path.join(__dirname, '../infra/migrations/208_exercise_translations.js');

describe('localizedExerciseNameSql()', () => {
  it('collapses to the base column for the base locale, so the common path costs nothing', async () => {
    const { localizedExerciseNameSql } = await import('../domain/exerciseTranslations');
    const { BASE_LOCALE } = await import('../infra/locale');
    expect(localizedExerciseNameSql('e', BASE_LOCALE)).toBe('e.name');
  });

  it('falls back to the base column for a translated locale', async () => {
    const { localizedExerciseNameSql } = await import('../domain/exerciseTranslations');
    const sql = localizedExerciseNameSql('e', 'ca' as any);
    expect(sql).toContain('exercise_translations');
    expect(sql).toContain("locale = 'ca'");
    expect(sql).toContain('COALESCE(');
    expect(sql.trimEnd().endsWith('e.name)')).toBe(true);
  });

  it('correlates on the caller\'s alias, so it composes inside any query', async () => {
    const { localizedExerciseNameSql } = await import('../domain/exerciseTranslations');
    expect(localizedExerciseNameSql('ex2', 'es' as any)).toContain('ext.exercise_id = ex2.id');
  });

  it('emits the allowlist entry, never a value handed to it', async () => {
    const { localizedExerciseNameSql } = await import('../domain/exerciseTranslations');
    // A forged tag never reaches the SQL: the helper looks the locale up in
    // SUPPORTED_LOCALES and embeds the entry it found, so anything else reads
    // the base column (#643's data-flow argument, which CodeQL reads the same way).
    for (const forged of ["es' OR 1=1 --", 'zz', '', 'en-US; DROP TABLE exercises']) {
      expect(localizedExerciseNameSql('e', forged as any)).toBe('e.name');
    }
  });
});

describe('exerciseNameSearchSql()', () => {
  it('matches the base name or any stored translation, with two placeholders', async () => {
    const { exerciseNameSearchSql } = await import('../domain/exerciseTranslations');
    const sql = exerciseNameSearchSql('e');
    // §7: a gym searching `Press de Banca` finds `Bench Press`. The clause is
    // locale-independent on purpose — any language's name matches.
    expect(sql).toContain('e.name LIKE ?');
    expect(sql).toContain('exercise_translations');
    expect(sql.match(/\?/g)).toHaveLength(2);
    expect(sql).not.toContain('locale =');
  });
});

describe('exerciseTranslationsExpr() / withExerciseTranslations()', () => {
  it('aggregates the stored names into one JSON object on the row', async () => {
    const { exerciseTranslationsExpr } = await import('../domain/exerciseTranslations');
    const sql = exerciseTranslationsExpr('e');
    expect(sql).toContain('JSON_OBJECTAGG');
    expect(sql).toContain('ext_all.exercise_id = e.id');
    expect(sql.trimEnd().endsWith('AS translations')).toBe(true);
  });

  it('reports {} for an exercise with none, so a form seeded from the row clears nothing', async () => {
    const { withExerciseTranslations } = await import('../domain/exerciseTranslations');
    expect(withExerciseTranslations({ translations: null }).translations).toEqual({});
    expect(withExerciseTranslations({}).translations).toEqual({});
    expect(withExerciseTranslations({ translations: { es: 'Press de Banca' } }).translations)
      .toEqual({ es: 'Press de Banca' });
  });

  it('parses a driver that hands JSON back as a string', async () => {
    const { withExerciseTranslations } = await import('../domain/exerciseTranslations');
    expect(withExerciseTranslations({ translations: '{"ca":"Press de banca"}' }).translations)
      .toEqual({ ca: 'Press de banca' });
  });
});

describe('validateExerciseTranslations()', () => {
  it('accepts the translatable locales', async () => {
    const { validateExerciseTranslations } = await import('../domain/exerciseTranslations');
    expect(validateExerciseTranslations({ es: 'Press de Banca', ca: 'Press de banca' })).toBeNull();
    expect(validateExerciseTranslations({})).toBeNull();
  });

  it('rejects the base locale — that is the exercise\'s own name column', async () => {
    const { validateExerciseTranslations } = await import('../domain/exerciseTranslations');
    expect(validateExerciseTranslations({ en: 'Bench Press' })?.error).toMatch(/base locale/);
  });

  it('rejects an unsupported locale rather than dropping it silently', async () => {
    const { validateExerciseTranslations } = await import('../domain/exerciseTranslations');
    expect(validateExerciseTranslations({ fr: 'Développé Couché' })?.error).toMatch(/unsupported locale/);
  });

  it('bounds a name by the base column\'s own length', async () => {
    const { validateExerciseTranslations } = await import('../domain/exerciseTranslations');
    expect(validateExerciseTranslations({ es: 'x'.repeat(200) })).toBeNull();
    expect(validateExerciseTranslations({ es: 'x'.repeat(201) })?.error).toMatch(/200 characters/);
  });

  it('rejects a non-object and a non-string value', async () => {
    const { validateExerciseTranslations } = await import('../domain/exerciseTranslations');
    expect(validateExerciseTranslations([])?.error).toBeTruthy();
    expect(validateExerciseTranslations('es')?.error).toBeTruthy();
    expect(validateExerciseTranslations({ es: 7 })?.error).toMatch(/must be a string/);
  });
});

describe('parseExerciseTranslations()', () => {
  it('reports undefined when the request never mentions the field', async () => {
    const { parseExerciseTranslations } = await import('../domain/exerciseTranslations');
    // Replace-all only when asked: a client editing another field must not clear
    // a gym's translations.
    expect(parseExerciseTranslations({ name: 'Bench Press' })).toEqual({});
  });

  it('reports the empty set when the request clears them explicitly', async () => {
    const { parseExerciseTranslations } = await import('../domain/exerciseTranslations');
    // Clearing is `{}`, not `null`: a null payload is a 400 rather than a silent
    // wipe, exactly as the Nutrition Library's own validation answers (#643).
    expect(parseExerciseTranslations({ translations: {} })).toEqual({ translations: {} });
    expect(parseExerciseTranslations({ translations: null }).error).toMatch(/object keyed by locale/);
  });

  it('reports the validation error rather than a partial payload', async () => {
    const { parseExerciseTranslations } = await import('../domain/exerciseTranslations');
    const parsed = parseExerciseTranslations({ translations: { fr: 'Développé Couché' } });
    expect(parsed.translations).toBeUndefined();
    expect(parsed.error).toMatch(/unsupported locale/);
  });
});

describe('the configuration is the application\'s, not the module\'s', () => {
  it('follows SUPPORTED_LOCALES / DEFAULT_LOCALE rather than a list of its own', async () => {
    process.env.SUPPORTED_LOCALES = 'es,en,fr';
    process.env.DEFAULT_LOCALE = 'es';
    const { localizedExerciseNameSql, validateExerciseTranslations } =
      await import('../domain/exerciseTranslations');
    // `es` is now the base column, `fr` is now translatable, `ca` is not configured.
    expect(localizedExerciseNameSql('e', 'es' as any)).toBe('e.name');
    expect(localizedExerciseNameSql('e', 'fr' as any)).toContain("locale = 'fr'");
    expect(validateExerciseTranslations({ fr: 'Développé Couché' })).toBeNull();
    expect(validateExerciseTranslations({ ca: 'Press de banca' })?.error).toMatch(/unsupported locale/);
  });
});

describe('every exercise read resolves the name through the one helper', () => {
  // The rule, asserted against the source rather than against a running query:
  // a surface that projects an exercise's name must take it from
  // `domain/exerciseTranslations.ts`, or a member reads English in one screen and
  // their own language in the next. There is one source of the SQL, so a new
  // reader either calls it or fails here.
  const API_DIR = path.join(__dirname, '../api');

  function routerSources(): { file: string; text: string }[] {
    return fs.readdirSync(API_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({ file: f, text: fs.readFileSync(path.join(API_DIR, f), 'utf8') }));
  }

  it('leaves no raw `e.name` projected as an exercise name', () => {
    const offenders = routerSources()
      .filter(({ text }) => /e\.name AS exercise_name|'exercise_name', e\.name/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('leaves the junction table itself to the domain module', () => {
    // A router may *name* it in a comment; what it must not do is query it, which
    // would be a second place deciding how a name resolves.
    const offenders = routerSources()
      .filter(({ text }) => /(FROM|JOIN|INTO|UPDATE)\s+exercise_translations/i.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

describe('migration 208', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  it('declares the junction shape the helpers query', () => {
    expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?\$\{TABLE\}/);
    expect(sql).toContain('PRIMARY KEY (exercise_id, locale)');
    expect(sql).toContain('KEY ext_locale_name (locale, name)');
    expect(sql).toContain('REFERENCES exercises(id) ON DELETE CASCADE');
  });

  it('mirrors the base column\'s length, so a translation can never be truncated', async () => {
    const { EXERCISE_TRANSLATIONS } = await import('../domain/exerciseTranslations');
    expect(sql).toContain(`VARCHAR(${EXERCISE_TRANSLATIONS.maxNameLength})`);
  });

  it('seeds nothing and backfills nothing — a name is never invented (§9)', () => {
    expect(sql).not.toMatch(/INSERT\s+(IGNORE\s+)?INTO/i);
    expect(sql).not.toMatch(/UPDATE\s+exercise/i);
  });

  it('takes the charset and collation from the column it is COALESCEd with', () => {
    expect(sql).toContain('information_schema.COLUMNS');
    expect(sql).toContain("TABLE_NAME = 'exercises'");
  });
});
