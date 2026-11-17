// #2951: the slug rule, its numeric suffix, and the migration's copy of both.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENTITY_SLUG_MAX, generateSlug, nextAvailableSlug } from '../domain/entitySlug';

describe('generateSlug()', () => {
  it.each([
    ['Squat', 'squat'],
    ['Romanian Deadlift', 'romanian-deadlift'],
    ['Équilibre Musculaire', 'equilibre-musculaire'],
    ['Personal Training (1:1)', 'personal-training-1-1'],
    ['  --Leading & trailing!!  ', 'leading-trailing'],
    ['Çà va — ñandú', 'ca-va-nandu'],
  ])('%s → %s', (name, slug) => {
    expect(generateSlug(name)).toBe(slug);
  });

  it('never answers an empty slug', () => {
    expect(generateSlug('!!!')).toBe('item');
    expect(generateSlug('', 'gym')).toBe('gym');
    expect(generateSlug(null, 'gym')).toBe('gym');
  });

  it('caps the length without a trailing hyphen', () => {
    const slug = generateSlug(`${'a'.repeat(ENTITY_SLUG_MAX - 1)} b`);
    expect(slug.length).toBeLessThanOrEqual(ENTITY_SLUG_MAX);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('nextAvailableSlug()', () => {
  it('keeps a free slug and suffixes a taken one with -2, -3, …', () => {
    expect(nextAvailableSlug('squat', [])).toBe('squat');
    expect(nextAvailableSlug('squat', ['squat'])).toBe('squat-2');
    expect(nextAvailableSlug('squat', ['squat', 'squat-2'])).toBe('squat-3');
  });

  it('stays within the maximum length when suffixing', () => {
    const base = 'a'.repeat(ENTITY_SLUG_MAX);
    const next = nextAvailableSlug(base, [base]);
    expect(next.length).toBe(ENTITY_SLUG_MAX);
    expect(next.endsWith('-2')).toBe(true);
  });
});

describe('migration 434 spells the same rule', () => {
  // A migration imports no application code, so it carries its own copy.
  const source = readFileSync(join(__dirname, '../infra/migrations/434_platform_entity_slugs.js'), 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const load = new Function(`${source.split('const TABLES')[0]}; return { generateSlug, nextAvailableSlug, SLUG_MAX };`);
  const migration = load() as {
    generateSlug: (n: string, f: string) => string;
    nextAvailableSlug: (b: string, used: Set<string>) => string;
    SLUG_MAX: number;
  };

  it('agrees with the domain module', () => {
    expect(migration.SLUG_MAX).toBe(ENTITY_SLUG_MAX);
    for (const name of ['Squat', 'Équilibre Musculaire', 'Personal Training (1:1)', '!!!', 'a'.repeat(200)]) {
      expect(migration.generateSlug(name, 'item')).toBe(generateSlug(name, 'item'));
    }
    expect(migration.nextAvailableSlug('squat', new Set(['squat', 'squat-2']))).toBe('squat-3');
  });
});
