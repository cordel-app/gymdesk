import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { goalDetail, goalLabel, humanizeSlug, translatedLabel } from '../lib/nutritionFood';

// #932 — My Nutrition shows the member's **Dietary Restrictions** beside their
// **Nutrition Goals**, both as image-plus-name rows.
//
// The label helpers are pure and are unit-tested directly. The rendering has no
// component-test infra in this repo (no testing-library, no jsdom), so — like
// nutrition-food-carousel.test.ts (#722) — the component and its call sites are
// pinned down by scanning their source.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const ROW = join(SRC, 'components', 'NutritionItemRow.tsx');
const NUTRITION_PAGE = join(SRC, 'app', '[locale]', 'nutrition', 'page.tsx');
const HOME_PAGE = join(SRC, 'app', '[locale]', 'page.tsx');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));
const readRaw = (path: string) => readFileSync(path, 'utf-8');

/** The real `t`: returns the message when the key is known, the key when it is not. */
function translator(messages: Record<string, string>) {
  return (key: string) => messages[key] ?? key;
}

// The goal vocabulary the three nutrition-plan routers validate `item_name`
// against (api/src/api/member-nutrition-plans.ts). Every one of them needs a
// label, or the member reads the raw slug.
const GOAL_SLUGS = [
  'protein', 'water', 'calories', 'carbohydrates', 'fats', 'fiber',
  'weight_loss', 'weight_gain', 'muscle_gain', 'maintenance',
  'performance', 'recovery', 'energy',
] as const;

describe('goal labels (#932 §2)', () => {
  const t = translator({
    'nutrition.goal_name.weight_loss': 'Weight loss',
    'nutrition.goal_frequency.daily': 'daily',
  });

  it('translates the stored slug instead of showing it', () => {
    expect(goalLabel(t, 'weight_loss')).toBe('Weight loss');
  });

  it('humanises a goal no locale file knows yet, never printing the key', () => {
    // next-intl has no `defaultValue` option: `t('x', { defaultValue })` renders
    // the key. The fallback is therefore decided before `t()` is called.
    expect(goalLabel(t, 'fasting')).toBe('Fasting');
    expect(goalLabel(t, 'fasting')).not.toContain('nutrition.goal_name');
  });

  it('reads a value and its frequency as "1 l · daily"', () => {
    expect(goalDetail(t, { quantity: '1.00', unit: 'l', frequency: 'daily' })).toBe('1 l · daily');
  });

  it('omits the half it has no value for rather than rendering an empty one', () => {
    expect(goalDetail(t, { quantity: '2.00', unit: 'portions', frequency: null })).toBe('2 portions');
    expect(goalDetail(t, { quantity: null, unit: null, frequency: 'daily' })).toBe('daily');
    expect(goalDetail(t, { quantity: null, unit: null, frequency: null })).toBeNull();
    expect(goalDetail(t, { quantity: null, unit: null, frequency: '  ' })).toBeNull();
  });

  it('spaces the unit and drops the DECIMAL\'s trailing zeros', () => {
    // `1.00l` and a dropped frequency were what the page rendered before #932.
    expect(goalDetail(t, { quantity: '1.00', unit: 'l', frequency: null })).toBe('1 l');
    expect(goalDetail(t, { quantity: '1.50', unit: 'l', frequency: null })).toBe('1.5 l');
  });

  it('humanises an unknown frequency instead of dropping it', () => {
    expect(goalDetail(t, { quantity: null, unit: null, frequency: 'twice_weekly' })).toBe('Twice weekly');
  });
});

describe('translatedLabel / humanizeSlug', () => {
  it('prefers the translation and falls back to the given string', () => {
    const t = translator({ known: 'Known' });
    expect(translatedLabel(t, 'known', 'fallback')).toBe('Known');
    expect(translatedLabel(t, 'missing', 'fallback')).toBe('fallback');
  });

  it('falls back when the translator throws or answers empty', () => {
    expect(translatedLabel(() => { throw new Error('missing'); }, 'k', 'fallback')).toBe('fallback');
    expect(translatedLabel(() => '', 'k', 'fallback')).toBe('fallback');
  });

  it('humanises a slug', () => {
    expect(humanizeSlug('muscle_gain')).toBe('Muscle gain');
    expect(humanizeSlug('water')).toBe('Water');
    expect(humanizeSlug('')).toBe('');
  });
});

describe('NutritionItemRow (#932 §3, §4)', () => {
  const src = read(ROW);

  it('renders the image the nutrition data already carries, never a generated one', () => {
    expect(src).toContain('src={imageSrc}');
    expect(src).toContain('imageUrl');
    expect(src).not.toMatch(/https?:\/\//);
  });

  it('keeps the thumbnail square and undistorted, like the food card', () => {
    expect(src).toContain("aspectRatio: '1 / 1'");
    expect(src).toContain("objectFit: 'contain'");
  });

  it('falls back to the app\'s standard placeholder for a missing or broken image', () => {
    expect(src).toContain('onError={() => setImageBroken(true)}');
    expect(src).toContain("t('nutrition.no_image')");
  });

  it('gives the image accessible text built from the item name', () => {
    expect(src).toContain("t('nutrition.food_image_alt', { name })");
  });

  it('omits the detail line rather than rendering an empty one', () => {
    expect(src).toContain('{detail && ');
  });

  it('is read-only — the member can neither add, edit nor remove a row (§6)', () => {
    expect(src).not.toMatch(/<(input|select|textarea|button|form)[\s>]/);
    expect(src).not.toMatch(/onClick|onChange|onSubmit/);
  });

  it('owns the look both sections share, so neither can drift from the other', () => {
    expect(src).toContain('borderRadius: 10');
    expect(src).toContain('width: 56');
  });
});

describe('My Nutrition page (#932 §1, §2, §5)', () => {
  const src = read(NUTRITION_PAGE);

  it('renders both sections through the one shared row', () => {
    expect(src).toContain("import { NutritionItemRow } from '@/components/NutritionItemRow';");
    expect(src).toContain('<NutritionItemRow key={r.id} name={r.item_name} imageUrl={r.image_url} />');
    expect(src).toContain('name={goalLabel(t, g.item_name)}');
    expect(src).toContain('detail={goalDetail(t, g)}');
  });

  it('builds no image markup of its own', () => {
    expect(src).not.toMatch(/<img[\s>]/);
  });

  it('shows a dietary restrictions section with its own heading', () => {
    expect(src).toContain("t('nutrition.restrictions')");
    expect(src).toContain('restrictions.map((r) =>');
    expect(src).toContain('plan?.restrictions ?? []');
  });

  it('says so in words when a section is empty instead of hiding it', () => {
    expect(src).toContain('goals.length === 0');
    expect(src).toContain('restrictions.length === 0');
    expect(src).toContain("t('nutrition.goals_empty')");
    expect(src).toContain("t('nutrition.restrictions_empty')");
  });

  it('reuses the existing /me/nutrition-plan request — no second fetch for either section', () => {
    expect(src.match(/apiFetch</g)).toHaveLength(1);
    expect(src).toContain("'/me/nutrition-plan'");
  });

  it('renders no raw slug and no hand-rolled quantity concatenation', () => {
    expect(src).not.toMatch(/\{g\.item_name\}/);
    expect(src).not.toMatch(/\{g\.quantity\}\{g\.unit\}/);
  });

  it('types both sections as the shared shapes', () => {
    expect(src).toContain('goals: NutritionGoalItem[]');
    expect(src).toContain('restrictions: NutritionRestrictionItem[]');
  });

  it('is read-only — no control reaches either section (§6)', () => {
    expect(src).not.toMatch(/<(input|select|textarea|form)[\s>]/);
    expect(src).not.toMatch(/apiFetch<[^>]*>\([^)]*method/);
  });
});

describe('Home card goals (#932 — the same helpers, so the two screens agree)', () => {
  const src = read(HOME_PAGE);

  it('translates the goal slug and formats its value the same way', () => {
    expect(src).toContain("from '@/lib/nutritionFood'");
    expect(src).toContain('goalLabel(t, g.item_name)');
    expect(src).toContain('goalDetail(t, g)');
    expect(src).not.toMatch(/\$\{g\.item_name\}/);
    expect(src).not.toMatch(/\$\{g\.quantity\}\$\{g\.unit\}/);
  });
});

describe('My Nutrition locales (#932)', () => {
  it.each(LOCALE_CODES)('%s defines both section headings and their empty states', (code) => {
    const nutrition = JSON.parse(readRaw(join(LOCALES_DIR, `${code}.json`))).nutrition;
    for (const key of ['goals', 'goals_empty', 'restrictions', 'restrictions_empty', 'no_image', 'food_image_alt']) {
      expect(nutrition[key], `${code}.json is missing nutrition.${key}`).toBeTruthy();
    }
  });

  it.each(LOCALE_CODES)('%s translates every goal of the routers\' vocabulary', (code) => {
    const nutrition = JSON.parse(readRaw(join(LOCALES_DIR, `${code}.json`))).nutrition;
    for (const slug of GOAL_SLUGS) {
      expect(nutrition.goal_name?.[slug], `${code}.json is missing nutrition.goal_name.${slug}`).toBeTruthy();
    }
  });

  it.each(LOCALE_CODES)('%s translates the frequencies the goal editor offers', (code) => {
    const nutrition = JSON.parse(readRaw(join(LOCALES_DIR, `${code}.json`))).nutrition;
    for (const frequency of ['daily', 'weekly']) {
      expect(nutrition.goal_frequency?.[frequency], `${code}.json is missing nutrition.goal_frequency.${frequency}`).toBeTruthy();
    }
  });
});
