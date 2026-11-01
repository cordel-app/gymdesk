import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1786 — every food row of the plan tree (read-only and editable lists, in
// templates and assigned plans, which share this component) leads with the
// food's circular thumbnail, from the image the API already returns.
const src = readFileSync(
  join(__dirname, '..', 'app', '[locale]', 'nutrition', 'nutrition-plan-templates', 'NutritionPlanTree.tsx'),
  'utf-8',
);

describe('meal item thumbnails', () => {
  it('draws a FoodThumbnail before the name in both item lists', () => {
    const rows = src.split('<FoodThumbnail imageUrl={item.item_image_url ?? null} size={TREE_AVATAR_SIZE} />');
    expect(rows.length - 1).toBe(0);
    for (const after of rows.slice(1)) {
      expect(after.trimStart().startsWith('<span style={{ fontSize: 13, fontWeight: 500 }}>{item.item_name}</span>')).toBe(true);
    }
  });
});
