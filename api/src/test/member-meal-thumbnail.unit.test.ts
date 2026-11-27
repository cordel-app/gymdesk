import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { mealThumbnailView, MEAL_THUMBNAIL_SIZE } from '../../../apps/member/src/lib/mealThumbnail';

// #3404 — every meal in Members App → My Nutrition carries a fixed-size circular
// thumbnail of its Base Meal, opening the app's one enlarged-image dialog on the
// full-size picture with the meal's name and description. In the API suite
// because CI runs `npm test` in `api/` only (#1009).

const MEMBER = join(__dirname, '..', '..', '..', 'apps', 'member', 'src');
const PAGE = readFileSync(join(MEMBER, 'app', '[locale]', 'nutrition', 'page.tsx'), 'utf-8');
const COMPONENT = readFileSync(join(MEMBER, 'components', 'MealThumbnail.tsx'), 'utf-8');

describe('mealThumbnailView', () => {
  const base = {
    base_meal_id: 3,
    meal_image_url: 'https://cdn.example/cordel/meals/3-breakfast.webp',
    meal_image_thumbnail_url: 'https://cdn.example/cordel/meals/3-breakfast-thumbnail.webp',
    meal_description: '  Start the day  ',
    meal_modified_at: '2026-11-25T10:00:00.000Z',
  };

  it('uses the thumbnail for the circle and the master for the dialog, cache-busted', () => {
    const v = mealThumbnailView(base);
    expect(v.thumbnailSrc).toBe(`${base.meal_image_thumbnail_url}?v=${encodeURIComponent(base.meal_modified_at)}`);
    expect(v.fullSrc).toBe(`${base.meal_image_url}?v=${encodeURIComponent(base.meal_modified_at)}`);
    expect(v.description).toBe('Start the day');
  });

  it('falls back to whichever picture exists', () => {
    expect(mealThumbnailView({ ...base, meal_image_thumbnail_url: null }).thumbnailSrc).toContain('3-breakfast.webp');
    expect(mealThumbnailView({ ...base, meal_image_url: null }).fullSrc).toContain('3-breakfast-thumbnail.webp');
  });

  it('reports no picture and no description for a meal without them', () => {
    expect(mealThumbnailView({ base_meal_id: 3 })).toEqual({ thumbnailSrc: null, fullSrc: null, description: null });
    expect(mealThumbnailView({ meal_image_url: 'javascript:alert(1)', meal_description: '   ' }))
      .toEqual({ thumbnailSrc: null, fullSrc: null, description: null });
  });

  it('is a fixed, heading-sized circle (#3428: 64–72 px)', () => {
    expect(MEAL_THUMBNAIL_SIZE).toBe(68);
  });
});

describe('My Nutrition meal rows', () => {
  it('draw the thumbnail in each meal header, before the name', () => {
    const head = PAGE.indexOf('<div style={styles.mealHead}>');
    expect(head).toBeGreaterThan(-1);
    const thumb = PAGE.indexOf('<MealThumbnail meal={meal}', head);
    const name = PAGE.indexOf('styles.mealName', head);
    expect(thumb).toBeGreaterThan(head);
    expect(thumb).toBeLessThan(name);
  });

  // #3428 — the meal header is a section heading on the page background:
  // outside the grey card, which holds only the meal's foods.
  it('put the meal header outside the grey card that holds its foods', () => {
    const block = PAGE.indexOf('<div key={meal.id} style={styles.mealBlock}>');
    const head = PAGE.indexOf('<div style={styles.mealHead}>', block);
    const card = PAGE.indexOf('<div style={styles.mealCard}>', block);
    const carousel = PAGE.indexOf('<NutritionFoodCarousel', block);
    expect(block).toBeGreaterThan(-1);
    expect(head).toBeGreaterThan(block);
    expect(card).toBeGreaterThan(head);
    expect(carousel).toBeGreaterThan(card);
    expect(PAGE).not.toMatch(/mealsForDate\.length === 0[\s\S]{0,200}<div style=\{styles\.card\}>\s*\{mealsForDate/);
    expect(PAGE).toMatch(/mealCard:\s*\{ \.\.\.sectionCardStyle/);
    expect(PAGE).toMatch(/mealName:[^\n]*fontSize: 22, fontWeight: 700/);
  });

  // #3546 — on a phone the completion actions wrap onto their own row under the
  // name, right-aligned, instead of squeezing it; on a wide screen they stay inline.
  it('group the completion actions so they wrap under the name, aligned right', () => {
    const head = PAGE.indexOf('<div style={styles.mealHead}>');
    const name = PAGE.indexOf('styles.mealName', head);
    const group = PAGE.indexOf('<div style={styles.mealActions}>', head);
    const fully = PAGE.indexOf("markMeal(meal, 'done')", head);
    const partially = PAGE.indexOf("markMeal(meal, 'partial')", head);
    expect(group).toBeGreaterThan(name);
    expect(fully).toBeGreaterThan(group);
    expect(partially).toBeGreaterThan(fully);
    expect(PAGE).toMatch(/mealHead:[^\n]*flexWrap: 'wrap'/);
    expect(PAGE).toMatch(/mealName:[^\n]*flex: '1 1 9rem', minWidth: 0/);
    expect(PAGE).toMatch(/mealActions:[^\n]*flexWrap: 'wrap', justifyContent: 'flex-end'[^\n]*marginLeft: 'auto'/);
  });

  it('reuse the app avatar circle and the one image preview dialog', () => {
    expect(COMPONENT).toContain('<MemberAvatar');
    expect(COMPONENT).toContain('<ImagePreviewButton');
    expect(COMPONENT).not.toMatch(/MemberDialog|<img/);
    expect(COMPONENT).not.toMatch(/['"`]#[0-9a-fA-F]{3,8}['"`]/);
  });
});
