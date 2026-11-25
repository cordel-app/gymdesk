import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #3408 — every ingredient row of a meal (and the add row) shares fixed-basis
// columns, so a long food name never moves Food Type, Food, Qty or Unit.
const src = readFileSync(
  join(__dirname, '..', 'app', '[locale]', 'nutrition', 'nutrition-plan-templates', 'NutritionPlanTree.tsx'),
  'utf-8',
);

function body(start: string, end: string): string {
  const from = src.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  return src.slice(from, src.indexOf(end, from));
}

describe('meal item columns are aligned (#3408)', () => {
  it('the food identity area has a fixed basis and the name truncates', () => {
    expect(src).toMatch(/const ITEM_IDENTITY_COL: React\.CSSProperties = \{ flex: '0 0 \d+px'/);
    expect(src).toMatch(/const ITEM_NAME_STYLE: React\.CSSProperties = \{[^}]*textOverflow: 'ellipsis'[^}]*whiteSpace: 'nowrap'/);
    expect(src).toMatch(/const ITEM_TRAILING_COL: React\.CSSProperties = \{ flex: '0 0 \d+px'/);
  });

  it('the full food name stays reachable through the link title', () => {
    expect(body('function FoodLink(', '\n}\n')).toContain('title={name}');
  });

  it('edit rows and the add row use the same column declarations', () => {
    const edit = body('function ItemEditRow(', '\n}\n');
    const add = body('{/* Add form */}', '<ConfirmDialog');
    for (const col of ['ITEM_ROW_STYLE', 'ITEM_IDENTITY_COL', 'ITEM_FOOD_TYPE_COL', 'ITEM_FOOD_COL', 'ITEM_QTY_COL', 'ITEM_UNIT_COL', 'ITEM_TRAILING_COL']) {
      expect(edit).toContain(col);
      expect(add).toContain(col);
    }
    expect(edit).toContain('nameStyle={ITEM_NAME_STYLE}');
    expect(edit).not.toContain("marginLeft: 'auto'");
  });
});
