import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1787 — gate: the Members App draws a theme-coloured cross over dietary
// restriction images only. CI runs `npm test` in api/ only, hence this file.
const member = (p: string) => readFileSync(join(__dirname, '../../../apps/member/src', p), 'utf8');

describe('dietary restriction cross (#1787)', () => {
  const row = member('components/NutritionItemRow.tsx');
  const page = member('app/[locale]/nutrition/page.tsx');

  it('only restrictions opt in to the cross', () => {
    const restrictionLine = page.split('\n').find((l) => l.includes('key={r.id}') && l.includes('r.image_url'))!;
    expect(restrictionLine).toContain('crossed');
    const goalBlock = page.slice(page.indexOf('<NutritionItemRow'), page.indexOf('</NutritionItemRow') > 0 ? page.indexOf('</NutritionItemRow') : page.indexOf('restrictions'));
    expect(goalBlock).not.toMatch(/\bcrossed\b/);
  });

  it('colours come from the theme, never a literal', () => {
    const svg = row.slice(row.indexOf('<svg'), row.indexOf('</svg>'));
    expect(svg).toContain('memberTheme.statusError');
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
