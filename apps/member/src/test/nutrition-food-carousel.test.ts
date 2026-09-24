import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { formatQuantity } from '../lib/nutritionFood';

// #722 — the Member app's nutrition foods are horizontal, swipeable image cards.
//
// `formatQuantity` is pure, so it is unit-tested directly. The rendering itself
// has no component-test infra in this repo (the Member app's dependencies are
// Next, next-intl, Clerk and FullCalendar — no testing-library, no jsdom), so —
// like apps/admin/src/test/exercise-media-thumbnails.test.ts (#720) — the two
// components and their call site are pinned down by scanning their source.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const CARD = join(SRC, 'components', 'NutritionFoodCard.tsx');
const CAROUSEL = join(SRC, 'components', 'NutritionFoodCarousel.tsx');
const NUTRITION_PAGE = join(SRC, 'app', '[locale]', 'nutrition', 'page.tsx');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Sources are scanned with their comments stripped — prose about a gesture is not one. */
const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));
const readRaw = (path: string) => readFileSync(path, 'utf-8');

describe('formatQuantity (#722 §3)', () => {
  it.each([
    ['250.00', 'g', '250 g'],
    [250, 'g', '250 g'],
    ['1.50', 'scoop', '1.5 scoop'],
    ['0.25', 'l', '0.25 l'],
    ['100.00', 'ml', '100 ml'],
  ])('renders %s %s as "%s"', (quantity, unit, expected) => {
    expect(formatQuantity(quantity as any, unit)).toBe(expected);
  });

  it('never hard-codes "g" — the unit is the plan\'s own', () => {
    expect(formatQuantity('2.00', 'units')).toBe('2 units');
    expect(formatQuantity('2.00', null)).toBe('2');
    expect(read(join(SRC, 'lib', 'nutritionFood.ts'))).not.toMatch(/['"`]\s?g['"`]/);
  });

  it('returns null when the plan prescribes no quantity, so the card omits the line', () => {
    expect(formatQuantity(null, 'g')).toBeNull();
    expect(formatQuantity(undefined, 'g')).toBeNull();
    expect(formatQuantity('', 'g')).toBeNull();
    expect(formatQuantity('not a number', 'g')).toBeNull();
  });
});

describe('NutritionFoodCard (#722 §2, §9, §10)', () => {
  const src = read(CARD);

  it('renders the image the nutrition data already carries, never a generated one', () => {
    expect(src).toContain('src={imageSrc}');
    expect(src).toContain('item.image_url');
  });

  it('keeps the image square and undistorted', () => {
    expect(src).toContain("aspectRatio: '1 / 1'");
    expect(src).toContain("objectFit: 'contain'");
  });

  it('lazy-loads every card but the first one of the carousel', () => {
    expect(src).toContain("loading={eager ? 'eager' : 'lazy'}");
    expect(src).toContain('decoding="async"');
  });

  it('falls back to the placeholder for a missing or broken image, keeping the information visible', () => {
    expect(src).toContain('onError={() => setImageBroken(true)}');
    expect(src).toContain("t('nutrition.no_image')");
  });

  it('omits every optional line rather than rendering an empty one', () => {
    expect(src).toContain('{quantity && ');
    expect(src).toContain('{role && ');
    expect(src).toContain('{qualities.length > 0 && ');
  });

  it('takes the role and the qualities from the data, never from the food name', () => {
    expect(src).toContain('item.component_type');
    expect(src).toContain('item.qualities');
    expect(src).not.toMatch(/item_name\s*\.\s*(includes|match|indexOf)/);
  });

  it('gives the image accessible text built from the food name', () => {
    expect(src).toContain("t('nutrition.food_image_alt', { name: item.item_name })");
  });
});

describe('NutritionFoodCarousel (#722 §1, §7, §13, §14)', () => {
  const src = read(CAROUSEL);

  it('scrolls horizontally with CSS scroll snapping — the browser\'s own swipe', () => {
    expect(src).toContain("overflowX: 'auto'");
    expect(src).toContain("scrollSnapType: 'x mandatory'");
    expect(src).toContain("scrollSnapAlign: 'center'");
  });

  it('shows one card at a time with the next one peeking, on any screen width', () => {
    expect(src).toContain("flex: '0 0 min(320px, 82%)'");
  });

  it('implements no gesture system of its own, so page scrolling keeps working', () => {
    expect(src).not.toMatch(/onTouch(Start|Move|End)/);
    expect(src).not.toMatch(/touchAction/);
    expect(src).toContain("overflowY: 'hidden'");
    // The only `preventDefault` calls are the two arrow-key ones: a touch
    // handler that cancelled the browser's default is exactly what would stop
    // the page scrolling vertically mid-swipe (§13).
    expect(src.match(/preventDefault\(\)/g)).toHaveLength(2);
    expect(src).toMatch(/Arrow(Right|Left)'\) \{ event\.preventDefault\(\);/);
  });

  it('derives the current card from the real scroll position, not from the buttons alone', () => {
    expect(src).toContain('onScroll={handleScroll}');
    expect(src).toContain('track.scrollLeft');
  });

  it('is keyboard navigable and exposes labelled previous/next controls', () => {
    expect(src).toContain('tabIndex={0}');
    expect(src).toContain("event.key === 'ArrowRight'");
    expect(src).toContain("event.key === 'ArrowLeft'");
    expect(src).toContain("aria-label={t('nutrition.previous_food')}");
    expect(src).toContain("aria-label={t('nutrition.next_food')}");
  });

  it('announces the position to assistive technology and does not rely on colour alone', () => {
    expect(src).toContain('aria-roledescription="carousel"');
    expect(src).toContain('aria-roledescription="slide"');
    expect(src).toContain('aria-live="polite"');
    expect(src).toContain("t('nutrition.carousel_position'");
  });

  it('replaces the dots with the counter once there are many foods', () => {
    expect(src).toContain('const MAX_DOTS = 8;');
    expect(src).toContain('items.length <= MAX_DOTS &&');
  });

  it('renders nothing for an empty meal and no controls for a single food', () => {
    expect(src).toContain('if (items.length === 0) return null;');
    expect(src).toContain('{items.length > 1 && (');
  });
});

describe('My Nutrition page (#722 §15, §16)', () => {
  const src = read(NUTRITION_PAGE);

  it('renders the meal\'s foods through the shared carousel', () => {
    expect(src).toContain("import { NutritionFoodCarousel } from '@/components/NutritionFoodCarousel';");
    expect(src).toContain('<NutritionFoodCarousel items={meal.items} label={meal.display_name} />');
  });

  it('keeps the existing plan structure (goals, days, meals, notes) around it', () => {
    expect(src).toContain("t('nutrition.goals')");
    expect(src).toContain('weekdayLabel(day.weekday)');
    expect(src).toContain('mealTypeLabel(meal.meal_type)');
    expect(src).toContain('{meal.notes && ');
  });

  it('reuses the existing /me/nutrition-plan request — no per-food fetch', () => {
    expect(src.match(/apiFetch</g)).toHaveLength(1);
    expect(src).toContain("'/me/nutrition-plan'");
  });

  it('builds no food-card markup of its own', () => {
    expect(src).not.toMatch(/<img[\s>]/);
    // The joined "name (250g) + name" line the carousel replaced. `item_name`
    // still appears on the page — but for the plan's *goals*, not for a food.
    expect(src).not.toMatch(/meal\.items\s*\.\s*map/);
  });

  it('types its meal items as the shared food shape', () => {
    expect(src).toContain("import { NutritionFoodItem } from '@/lib/nutritionFood';");
    expect(src).toContain('items: NutritionFoodItem[]');
  });
});

describe('nutrition carousel locales (#722)', () => {
  it.each(LOCALE_CODES)('%s defines the card and carousel labels', (code) => {
    const messages = JSON.parse(readRaw(join(LOCALES_DIR, `${code}.json`)));
    const nutrition = messages.nutrition;
    for (const key of ['food_image_alt', 'no_image', 'carousel_label', 'carousel_position', 'previous_food', 'next_food']) {
      expect(nutrition[key], `${code}.json is missing nutrition.${key}`).toBeTruthy();
    }
    expect(nutrition.food_image_alt).toContain('{name}');
    expect(nutrition.carousel_label).toContain('{meal}');
    expect(nutrition.carousel_position).toContain('{current}');
    expect(nutrition.carousel_position).toContain('{total}');
  });

  it.each(LOCALE_CODES)('%s translates every component type the schema allows', (code) => {
    const messages = JSON.parse(readRaw(join(LOCALES_DIR, `${code}.json`)));
    // The CHECK on member_nutrition_plan_meal_items.component_type (migration
    // 105, widened by 111 for the template side).
    expect(Object.keys(messages.nutrition.component_type).sort())
      .toEqual(['additional', 'dessert', 'drink', 'main_dish', 'other', 'sauce', 'side']);
  });

  it.each(LOCALE_CODES)('%s translates every nutritional quality in the catalogue', (code) => {
    const messages = JSON.parse(readRaw(join(LOCALES_DIR, `${code}.json`)));
    // `nutritional_qualities.slug` — protein/carbohydrate (migration 110),
    // fat/fiber (migration 142).
    expect(Object.keys(messages.nutrition.quality).sort())
      .toEqual(['carbohydrate', 'fat', 'fiber', 'protein']);
  });
});
