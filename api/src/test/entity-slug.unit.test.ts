// #2951: the slug rule, its numeric suffix, and the migration's copy of both.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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

describe('migration 435 spells the same rule', () => {
  // A migration imports no application code, so it carries its own copy.
  const source = readFileSync(join(__dirname, '../infra/migrations/435_platform_entity_slugs.js'), 'utf8');
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

describe('migration 437 spells the same rule', () => {
  const source = readFileSync(join(__dirname, '../infra/migrations/437_exercise_slugs.js'), 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const load = new Function(`${source.split('const GYM_KEY')[0]}; return { generateSlug, nextAvailableSlug, SLUG_MAX };`);
  const migration = load() as {
    generateSlug: (n: string, f: string) => string;
    nextAvailableSlug: (b: string, used: Set<string>) => string;
    SLUG_MAX: number;
  };

  it('agrees with the domain module', () => {
    expect(migration.SLUG_MAX).toBe(ENTITY_SLUG_MAX);
    for (const name of ['Romanian Deadlift', 'Équilibre Musculaire', 'Personal Training (1:1)', '', 'b'.repeat(200)]) {
      expect(migration.generateSlug(name, 'exercise')).toBe(generateSlug(name, 'exercise'));
    }
    expect(migration.nextAvailableSlug('squat', new Set(['squat']))).toBe('squat-2');
  });
});

describe('every production exercise insert writes a slug (#2951 stage 2)', () => {
  // The slug columns stay nullable (the Base id reservation inserts a placeholder row with no gym),
  // so the writers are what guarantee a slug; a new INSERT that forgot it would read back with none.
  const files = ['../api/exercises.ts', '../api/platform-exercises.ts'];
  for (const file of files) {
    it(`${file} names slug in each INSERT`, () => {
      const source = readFileSync(join(__dirname, file), 'utf8');
      const inserts = source.match(/INSERT INTO (?:exercises\b|\$\{B\.exercises\})[\s\S]*?VALUES/g) ?? [];
      expect(inserts.length).toBeGreaterThan(0);
      for (const sql of inserts) expect(sql).toMatch(/\bslug\b/);
    });
  }
});

describe('migration 438 spells the same rule', () => {
  const source = readFileSync(join(__dirname, '../infra/migrations/438_goal_slugs.js'), 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const load = new Function(`${source.split('const GYM_TABLES')[0]}; return { generateSlug, nextAvailableSlug, SLUG_MAX };`);
  const migration = load() as {
    generateSlug: (n: string, f: string) => string;
    nextAvailableSlug: (b: string, used: Set<string>) => string;
    SLUG_MAX: number;
  };

  it('agrees with the domain module', () => {
    expect(migration.SLUG_MAX).toBe(ENTITY_SLUG_MAX);
    for (const name of ['Weight Loss', 'Équilibre Musculaire', 'Personal Training (1:1)', '', 'c'.repeat(200)]) {
      expect(migration.generateSlug(name, 'goal')).toBe(generateSlug(name, 'goal'));
    }
    expect(migration.nextAvailableSlug('water', new Set(['water']))).toBe('water-2');
  });
});

describe('every production goal insert writes a slug (#2951 stage 3)', () => {
  // `entity_slug` stays nullable (the Base id reservation inserts a placeholder gym row with no
  // gym), so the writers are what guarantee one. The placeholder itself names neither.
  const cases: [string, RegExp, RegExp][] = [
    ['../api/goal-library.ts', /INSERT INTO \$\{table\}[\s\S]*?VALUES/g, /\bentity_slug\b/],
    ['../api/gym-default-personal-goals.ts', /INSERT IGNORE INTO personal_goals\b[\s\S]*?VALUES/g, /\bentity_slug\b/],
    ['../api/platform-base-personal-goals.ts', /INSERT INTO \$\{TABLE\}[\s\S]*?VALUES/g, /\bslug\b/],
    ['../api/platform-base-nutrition-goals.ts', /INSERT INTO \$\{TABLE\}[\s\S]*?VALUES/g, /\bslug\b/],
  ];
  for (const [file, pattern, column] of cases) {
    it(`${file} names the slug in each goal INSERT`, () => {
      const source = readFileSync(join(__dirname, file), 'utf8');
      const inserts = source.match(pattern) ?? [];
      expect(inserts.length).toBeGreaterThan(0);
      for (const sql of inserts) expect(sql).toMatch(column);
    });
  }
});

describe('migration 439 carries the same slug rule (#2951 stage 4)', () => {
  const source = readFileSync(join(__dirname, '../infra/migrations/439_professional_service_slugs.js'), 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const load = new Function(`${source.split('const UNIQUE_KEY')[0]}; return { generateSlug, nextAvailableSlug, SLUG_MAX };`);
  const migration = load() as {
    generateSlug: (name: string, fallback: string) => string;
    nextAvailableSlug: (base: string, used: Set<string>) => string;
    SLUG_MAX: number;
  };

  it('agrees with the domain module', () => {
    expect(migration.SLUG_MAX).toBe(ENTITY_SLUG_MAX);
    for (const name of ['Personal Training (1:1)', 'Équilibre Musculaire', '  Física -- Duo ', '***']) {
      expect(migration.generateSlug(name, 'item')).toBe(generateSlug(name));
    }
    expect(migration.nextAvailableSlug('group-class', new Set(['group-class', 'group-class-2']))).toBe('group-class-3');
  });
});

describe('every production Professional Service insert writes a slug (#2951 stage 4)', () => {
  // `slug` stays nullable (as the exercise and goal columns do), so the writers are what
  // guarantee one: every INSERT into the table, in any production file, must name it.
  const root = join(__dirname, '..');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.startsWith('test') && !f.includes('infra/migrations'));
  const inserts = files.flatMap((f) =>
    (readFileSync(join(root, f), 'utf8').match(/INSERT (?:IGNORE )?INTO professional_services\b[\s\S]*?VALUES/g) ?? [])
      .map((sql) => [f, sql] as const));

  it('finds the four writers', () => {
    expect(inserts.length).toBeGreaterThanOrEqual(4);
  });
  it.each(inserts)('%s names slug', (_file, sql) => {
    expect(sql).toMatch(/\bslug\b/);
  });
});
