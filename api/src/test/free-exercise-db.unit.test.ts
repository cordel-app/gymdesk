/**
 * #964 — the Free Exercise DB mapping: the slug, the muscle catalogue, the
 * Exercise Type inference, the instruction order, the matching precedence and
 * the two properties the whole import rests on — **no image is ever read** (§10)
 * and a second run changes nothing (§2, §17).
 *
 * Pure module, no DB (CLAUDE.md): `domain/freeExerciseDb.ts` is the one place
 * every rule lives, and the script around it only does I/O. Migration 207 is
 * read as text, the way `session-benefit-frequency.unit.test.ts` reads back
 * migration 205's CHECK.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EXERCISE_SLUG_MAX,
  ExistingBaseExercise,
  SOURCE_ID_MAX,
  FREE_EXERCISE_DB_DEFAULT_URL,
  FREE_EXERCISE_DB_MUSCLE_ALIASES,
  FREE_EXERCISE_DB_SOURCE,
  SourceExercise,
  classifyExerciseType,
  composeInstructions,
  disambiguateSlug,
  mapSourceMuscle,
  mapSourceMuscles,
  matchExistingExercise,
  parseSourceDataset,
  parseSourceExercise,
  planExerciseImport,
  slugifyExerciseName,
  sourceMetadata,
} from '../domain/freeExerciseDb';
import { EXERCISE_TYPES } from '../domain/exerciseTypes';
import { MUSCLE_KEYS } from '../domain/muscles';

/** One real dataset entry, verbatim from `dist/exercises.json`. */
const RAW_ENTRY = {
  name: 'Alternate Incline Dumbbell Curl',
  force: 'pull',
  level: 'beginner',
  mechanic: 'isolation',
  equipment: 'dumbbell',
  primaryMuscles: ['biceps'],
  secondaryMuscles: ['forearms'],
  instructions: [
    'Sit on an incline bench with a dumbbell in each hand.',
    'Curl the right dumbbell up.',
    'Repeat with the left arm.',
  ],
  category: 'strength',
  images: ['Alternate_Incline_Dumbbell_Curl/0.jpg', 'Alternate_Incline_Dumbbell_Curl/1.jpg'],
  id: 'Alternate_Incline_Dumbbell_Curl',
};

function parsed(overrides: Partial<typeof RAW_ENTRY> = {}): SourceExercise {
  const result = parseSourceExercise({ ...RAW_ENTRY, ...overrides });
  if (!result.ok) throw new Error(`fixture does not parse: ${result.problem}`);
  return result.value;
}

function existing(overrides: Partial<ExistingBaseExercise> = {}): ExistingBaseExercise {
  return {
    id: 1,
    name: 'Alternate Incline Dumbbell Curl',
    slug: null,
    source: null,
    source_id: null,
    status: 'active',
    description: null,
    // `exercises.exercise_type` is NOT NULL with a `reps` default (migration
    // 071), so this is what every real row carries — which is also why an update
    // never moves it: a value somebody chose is not the importer's to overwrite.
    exercise_type: 'reps',
    equipment: null,
    category: null,
    level: null,
    mechanic: null,
    force_type: null,
    existingMuscleKeys: [],
    ...overrides,
  };
}

describe('§10 — images are not imported, and cannot be', () => {
  it('drops the dataset’s images field before anything else can see it', () => {
    const value = parsed();
    expect('images' in (value as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(value)).not.toContain('.jpg');
  });

  it('neither the mapping module nor the importer mentions an image column', () => {
    const domain = readFileSync(join(__dirname, '../domain/freeExerciseDb.ts'), 'utf8');
    const script = readFileSync(join(__dirname, '../scripts/import-free-exercise-db.ts'), 'utf8');
    for (const [name, source] of [['domain', domain], ['script', script]] as const) {
      expect(source, name).not.toContain('image_url');
      expect(source, name).not.toContain('image_thumbnail_url');
      expect(source, name).not.toContain('video_url');
      expect(source, name).not.toContain('raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/');
    }
    // The only `images` reference in the mapping module is the paragraph saying so.
    expect(domain).toContain('read by nothing here');
  });

  it('fetches the structured dataset rather than the repository’s pages (§2)', () => {
    expect(FREE_EXERCISE_DB_DEFAULT_URL).toMatch(/dist\/exercises\.json$/);
  });
});

describe('§15 step 2 — validation', () => {
  it('accepts the dataset as an array, and as an { exercises: [] } wrapper', () => {
    expect(parseSourceDataset([RAW_ENTRY])).toEqual({ ok: true, rows: [RAW_ENTRY] });
    expect(parseSourceDataset({ exercises: [RAW_ENTRY] })).toEqual({ ok: true, rows: [RAW_ENTRY] });
    expect(parseSourceDataset({ nope: 1 }).ok).toBe(false);
  });

  it('reports a malformed entry instead of throwing (§16)', () => {
    expect(parseSourceExercise({ name: 'No id' })).toMatchObject({ ok: false, problem: 'missing id', name: 'No id' });
    expect(parseSourceExercise({ id: 'x' })).toMatchObject({ ok: false, problem: 'missing name', sourceId: 'x' });
    expect(parseSourceExercise({ id: 'x', name: 'y'.repeat(201) })).toMatchObject({ ok: false });
  });

  it('tolerates every optional field being absent', () => {
    const result = parseSourceExercise({ id: 'x', name: 'Air Squat' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      force: null, level: null, mechanic: null, equipment: null, category: null,
      primaryMuscles: [], secondaryMuscles: [], instructions: [],
    });
  });
});

describe('§5 — the slug', () => {
  it('spells the ticket’s own example', () => {
    expect(slugifyExerciseName('Alternate Incline Dumbbell Curl')).toBe('alternate-incline-dumbbell-curl');
  });

  it('collapses punctuation and folds diacritics', () => {
    expect(slugifyExerciseName('3/4 Sit-Up')).toBe('3-4-sit-up');
    expect(slugifyExerciseName('  Cable   Row  ')).toBe('cable-row');
    expect(slugifyExerciseName('Rückenübung')).toBe('ruckenubung');
  });

  it('stays inside the column and never starts or ends with a hyphen', () => {
    const slug = slugifyExerciseName('!'.repeat(10) + 'x'.repeat(400));
    expect(slug.length).toBeLessThanOrEqual(EXERCISE_SLUG_MAX);
    expect(slug.startsWith('-')).toBe(false);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('disambiguates with the source id, so the result is stable across runs', () => {
    expect(disambiguateSlug('curl', 'Alternate_Incline_Dumbbell_Curl'))
      .toBe('curl-alternate-incline-dumbbell-curl');
    expect(disambiguateSlug('curl', 'Alternate_Incline_Dumbbell_Curl'))
      .toBe(disambiguateSlug('curl', 'Alternate_Incline_Dumbbell_Curl'));
  });
});

describe('§8 — muscles', () => {
  it('reuses an existing key for the dataset’s other spelling of it', () => {
    expect(FREE_EXERCISE_DB_MUSCLE_ALIASES).toEqual({ quadriceps: 'quads', abdominals: 'core' });
    expect(mapSourceMuscle('quadriceps')).toMatchObject({ key: 'quads', known: true });
    expect(mapSourceMuscle('abdominals')).toMatchObject({ key: 'core', known: true });
    expect(mapSourceMuscle('Chest')).toMatchObject({ key: 'chest', known: true });
  });

  it('normalizes a multi-word muscle to a storable key', () => {
    expect(mapSourceMuscle('middle back')).toMatchObject({ key: 'middle_back', known: true });
    expect(mapSourceMuscle('lower back')).toMatchObject({ key: 'lower_back', known: true });
  });

  it('offers every muscle the dataset uses, so none is stored unselectable', () => {
    const sourceMuscles = [
      'quadriceps', 'shoulders', 'abdominals', 'chest', 'hamstrings', 'triceps', 'biceps',
      'lats', 'middle back', 'lower back', 'calves', 'forearms', 'glutes', 'traps',
      'adductors', 'neck', 'abductors',
    ];
    for (const name of sourceMuscles) {
      const mapped = mapSourceMuscle(name);
      expect(mapped, name).not.toBeNull();
      expect(mapped!.known, `${name} → ${mapped!.key}`).toBe(true);
    }
  });

  it('three source values stay three muscles rather than collapsing into back', () => {
    for (const key of ['lats', 'middle_back', 'lower_back']) {
      expect(MUSCLE_KEYS as readonly string[]).toContain(key);
    }
  });

  it('keeps the dataset’s own primary/secondary split, principal winning a tie', () => {
    const { links } = mapSourceMuscles(parsed({ primaryMuscles: ['chest'], secondaryMuscles: ['chest', 'triceps'] }));
    expect(links).toEqual([{ key: 'chest', role: 'principal' }, { key: 'triceps', role: 'secondary' }]);
  });

  it('reports a muscle it cannot store rather than failing (§16)', () => {
    const { links, unmapped } = mapSourceMuscles(parsed({ primaryMuscles: ['!!!'], secondaryMuscles: [] }));
    expect(links).toEqual([]);
    expect(unmapped).toEqual(['!!!']);
  });

  it('every offered key has a label in all three admin locales', () => {
    for (const locale of ['en', 'es', 'ca']) {
      const path = join(__dirname, '../../../apps/admin/locales/base', `${locale}.json`);
      const labels = JSON.parse(readFileSync(path, 'utf8')).muscles as Record<string, string>;
      for (const key of MUSCLE_KEYS) {
        expect(labels[key], `${locale}.muscles.${key}`).toBeTruthy();
      }
    }
  });
});

describe('§7 — Exercise Type', () => {
  it('maps a category onto the existing taxonomy and invents no value', () => {
    expect(classifyExerciseType(parsed({ category: 'strength' }))).toMatchObject({ type: 'reps', confident: true });
    expect(classifyExerciseType(parsed({ category: 'powerlifting' }))).toMatchObject({ type: 'reps' });
    expect(classifyExerciseType(parsed({ category: 'olympic weightlifting' }))).toMatchObject({ type: 'reps' });
    expect(classifyExerciseType(parsed({ category: 'strongman' }))).toMatchObject({ type: 'reps' });
    expect(classifyExerciseType(parsed({ category: 'plyometrics' }))).toMatchObject({ type: 'reps' });
    expect(classifyExerciseType(parsed({ category: 'stretching' }))).toMatchObject({ type: 'time', confident: true });
    for (const value of EXERCISE_TYPES) expect(['reps', 'time', 'distance']).toContain(value);
  });

  it('flags cardio as the closest existing type rather than guessing', () => {
    expect(classifyExerciseType(parsed({ category: 'cardio' })))
      .toEqual({ type: 'time', confident: false, sourceValue: 'cardio' });
  });

  it('leaves an unknown or missing category unset, and reports the source value', () => {
    expect(classifyExerciseType(parsed({ category: 'mobility' })))
      .toEqual({ type: null, confident: false, sourceValue: 'mobility' });
    expect(classifyExerciseType(parsed({ category: null as any })))
      .toEqual({ type: null, confident: false, sourceValue: null });
  });

  it('never takes the type from equipment — "barbell" says nothing about measurement', () => {
    const noCategory = parsed({ category: null as any, equipment: 'barbell' });
    expect(classifyExerciseType(noCategory).type).toBeNull();
  });
});

describe('§6 / §9 — metadata and instructions', () => {
  it('preserves the five source values verbatim, force under force_type', () => {
    expect(sourceMetadata(parsed())).toEqual({
      equipment: 'dumbbell', category: 'strength', level: 'beginner', mechanic: 'isolation', force_type: 'pull',
    });
    expect(sourceMetadata(parsed({ equipment: 'body only' })).equipment).toBe('body only');
  });

  it('keeps the instruction order, numbering the steps', () => {
    expect(composeInstructions(['First.', 'Second.', 'Third.']))
      .toBe('1. First.\n2. Second.\n3. Third.');
  });

  it('does not number a single step, and answers null for none', () => {
    expect(composeInstructions(['Only one.'])).toBe('Only one.');
    expect(composeInstructions([])).toBeNull();
    expect(composeInstructions(['  '])).toBeNull();
  });

  it('does not rewrite the wording', () => {
    const step = 'Keep your back ¾ straight — do not round it.';
    expect(composeInstructions([step])).toBe(step);
  });
});

describe('§12 — matching, and what a match does', () => {
  it('matches on provenance first', () => {
    const row = existing({ id: 7, name: 'Renamed by an administrator', source: FREE_EXERCISE_DB_SOURCE, source_id: RAW_ENTRY.id });
    const { match } = matchExistingExercise(parsed(), [existing({ id: 8 }), row]);
    expect(match).toEqual({ row, kind: 'source_id' });
  });

  it('then on the stable slug, then on an exact name', () => {
    const bySlug = existing({ id: 2, name: 'Something else', slug: 'alternate-incline-dumbbell-curl' });
    expect(matchExistingExercise(parsed(), [bySlug]).match).toEqual({ row: bySlug, kind: 'slug' });
    const byName = existing({ id: 3, name: '  alternate incline DUMBBELL curl ' });
    expect(matchExistingExercise(parsed(), [byName]).match).toEqual({ row: byName, kind: 'name' });
  });

  it('is conservative about names — a near miss is not a match', () => {
    const other = existing({ id: 4, name: 'Alternate Incline Dumbbell Curl (Standing)' });
    expect(matchExistingExercise(parsed(), [other])).toEqual({ match: null, potentialDuplicate: null });
  });

  it('reports rather than merges when the name belongs to another source id', () => {
    const claimed = existing({ id: 5, source: FREE_EXERCISE_DB_SOURCE, source_id: 'Another_Id' });
    const result = matchExistingExercise(parsed(), [claimed]);
    expect(result.match).toBeNull();
    expect(result.potentialDuplicate).toBe(claimed);
  });

  it('creates with everything, provenance included', () => {
    const plan = planExerciseImport(parsed(), null, { slug: 'alternate-incline-dumbbell-curl' });
    expect(plan.action).toBe('create');
    expect(plan.fields).toMatchObject({
      name: 'Alternate Incline Dumbbell Curl',
      slug: 'alternate-incline-dumbbell-curl',
      source: FREE_EXERCISE_DB_SOURCE,
      source_id: RAW_ENTRY.id,
      exercise_type: 'reps',
      equipment: 'dumbbell',
      force_type: 'pull',
    });
    expect(plan.fields.description).toContain('1. Sit on an incline bench');
    expect(plan.muscles).toEqual([{ key: 'biceps', role: 'principal' }, { key: 'forearms', role: 'secondary' }]);
  });

  it('a second run over the row it just wrote changes nothing (§2, §17)', () => {
    const src = parsed();
    const first = planExerciseImport(src, null, { slug: 'alternate-incline-dumbbell-curl' });
    const row = existing({
      id: 9,
      name: first.fields.name!,
      slug: first.fields.slug!,
      source: first.fields.source!,
      source_id: first.fields.source_id!,
      description: first.fields.description ?? null,
      exercise_type: first.fields.exercise_type ?? null,
      equipment: first.fields.equipment ?? null,
      category: first.fields.category ?? null,
      level: first.fields.level ?? null,
      mechanic: first.fields.mechanic ?? null,
      force_type: first.fields.force_type ?? null,
      existingMuscleKeys: first.muscles.map((link) => link.key),
    });
    const { match } = matchExistingExercise(src, [row]);
    const second = planExerciseImport(src, match, { slug: 'alternate-incline-dumbbell-curl' });
    expect(second.action).toBe('unchanged');
    expect(second.fields).toEqual({});
    expect(second.muscles).toEqual([]);
  });

  it('never overwrites a name or a description an administrator edited', () => {
    const row = existing({
      id: 10,
      name: 'Alternate Incline Curl (our wording)',
      slug: 'alternate-incline-dumbbell-curl',
      source: FREE_EXERCISE_DB_SOURCE,
      source_id: RAW_ENTRY.id,
      description: 'Our own coaching cues.',
      equipment: 'dumbbell', category: 'strength', level: 'beginner', mechanic: 'isolation', force_type: 'pull',
      existingMuscleKeys: ['biceps', 'forearms'],
    });
    const { match } = matchExistingExercise(parsed(), [row]);
    const plan = planExerciseImport(parsed(), match, { slug: 'alternate-incline-dumbbell-curl' });
    expect(plan.action).toBe('unchanged');
    expect(plan.fields.name).toBeUndefined();
    expect(plan.fields.description).toBeUndefined();
  });

  it('stamps provenance onto a row it adopts, and fills only what is empty', () => {
    const row = existing({ id: 11, name: 'Alternate Incline Dumbbell Curl', description: 'Legacy text.' });
    const { match } = matchExistingExercise(parsed(), [row]);
    const plan = planExerciseImport(parsed(), match, { slug: 'alternate-incline-dumbbell-curl' });
    expect(plan.adopted).toBe(true);
    expect(plan.action).toBe('update');
    expect(plan.fields).toMatchObject({
      source: FREE_EXERCISE_DB_SOURCE, source_id: RAW_ENTRY.id, slug: 'alternate-incline-dumbbell-curl',
      equipment: 'dumbbell',
    });
    expect(plan.fields.description).toBeUndefined();
    expect(plan.muscles).toEqual([{ key: 'biceps', role: 'principal' }, { key: 'forearms', role: 'secondary' }]);
  });

  it('adds a missing muscle link and removes none (§14’s spirit)', () => {
    const row = existing({
      id: 12, slug: 'alternate-incline-dumbbell-curl',
      source: FREE_EXERCISE_DB_SOURCE, source_id: RAW_ENTRY.id,
      description: 'kept', equipment: 'dumbbell', category: 'strength', level: 'beginner',
      mechanic: 'isolation', force_type: 'pull',
      existingMuscleKeys: ['biceps', 'core'],
    });
    const { match } = matchExistingExercise(parsed(), [row]);
    const plan = planExerciseImport(parsed(), match, { slug: 'alternate-incline-dumbbell-curl' });
    expect(plan.muscles).toEqual([{ key: 'forearms', role: 'secondary' }]);
  });

  it('keeps the source metadata in step when the dataset changes it', () => {
    const row = existing({
      id: 13, slug: 'alternate-incline-dumbbell-curl',
      source: FREE_EXERCISE_DB_SOURCE, source_id: RAW_ENTRY.id, description: 'kept',
      equipment: 'barbell', category: 'strength', level: 'beginner', mechanic: 'isolation', force_type: 'pull',
      existingMuscleKeys: ['biceps', 'forearms'],
    });
    const { match } = matchExistingExercise(parsed(), [row]);
    const plan = planExerciseImport(parsed(), match, { slug: 'alternate-incline-dumbbell-curl' });
    expect(plan.action).toBe('update');
    expect(plan.fields).toEqual({ equipment: 'dumbbell' });
  });

  it('skips a Base Exercise somebody deleted rather than re-creating it (§13)', () => {
    const row = existing({ id: 14, status: 'deleted', source: FREE_EXERCISE_DB_SOURCE, source_id: RAW_ENTRY.id });
    const { match } = matchExistingExercise(parsed(), [row]);
    const plan = planExerciseImport(parsed(), match, { slug: 'alternate-incline-dumbbell-curl' });
    expect(plan).toMatchObject({ action: 'skip', skipReason: 'deleted_locally' });
  });

  it('does not match a deleted row by slug or name either', () => {
    const deleted = existing({ id: 15, status: 'deleted', slug: 'alternate-incline-dumbbell-curl' });
    expect(matchExistingExercise(parsed(), [deleted])).toEqual({ match: null, potentialDuplicate: null });
  });
});

describe('migration 207 mirrors what the importer writes', () => {
  const path = join(__dirname, '../infra/migrations/207_exercise_source_provenance.js');
  const migration = readFileSync(path, 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const declared = require(path) as {
    COLUMNS: [string, string][];
    KEYS: { column: string; definition: string; index: string }[];
  };
  const width = (column: string) => {
    const entry = declared.COLUMNS.find(([name]) => name === column);
    return Number(/VARCHAR\((\d+)\)/.exec(entry![1])![1]);
  };

  it('declares the same widths the mapping module clamps to', () => {
    expect(width('slug')).toBe(EXERCISE_SLUG_MAX);
    expect(width('source_id')).toBe(SOURCE_ID_MAX);
    // The five metadata columns, whose clamps live beside them in the module.
    expect(width('equipment')).toBe(60);
    expect(width('category')).toBe(60);
    expect(width('level')).toBe(30);
    expect(width('mechanic')).toBe(30);
    expect(width('force_type')).toBe(30);
    const metadata = sourceMetadata(parsed({ equipment: 'x'.repeat(200) }));
    expect(metadata.equipment!.length).toBe(width('equipment'));
  });

  it('indexes the source id case-sensitively, as the matcher compares it', () => {
    const sourceKey = declared.KEYS.find((key) => key.column === 'base_source_key')!;
    expect(sourceKey.definition).toContain('utf8mb4_bin');
  });

  it('refuses a down() that would strip provenance from imported rows', () => {
    expect(migration).toContain('refusing to drop it');
    expect(migration).toContain('WHERE gym_id IS NULL AND source_id IS NOT NULL');
  });

  it('declares every column the plan can write', () => {
    for (const column of ['source', 'source_id', 'slug', 'equipment', 'category', 'level', 'mechanic', 'force_type']) {
      expect(migration, column).toContain(`'${column}'`);
    }
  });

  it('scopes both unique keys to Base Exercises, deleted rows keeping their provenance', () => {
    expect(migration).toContain('gym_id IS NULL AND source IS NOT NULL');
    expect(migration).toContain("gym_id IS NULL AND status <> 'deleted' AND slug IS NOT NULL");
  });

  it('adds no media column and no second catalogue (§10, §11)', () => {
    expect(migration).not.toMatch(/ADD COLUMN image|ADD COLUMN video|CREATE TABLE/);
  });
});
