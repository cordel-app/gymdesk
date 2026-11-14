import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { newMemberChipStyle, profileInlineValueStyle } from '../app/[locale]/members/MemberProfileLayout';
import { listNameBadgeAccentStyle } from '../components/listChrome';
import { formValueStyle } from '../components/formChrome';

// Regression tests for #2807 — the Profile's `Welcomed` value is regular text,
// not the yellow badge; the `New Member` chip keeps its look. No component-test
// infra exists for apps/admin, so the structure is asserted on the source.
const layoutSrc = readFileSync(join(__dirname, '../app/[locale]/members/MemberProfileLayout.tsx'), 'utf8');
const start = layoutSrc.indexOf('export function WelcomedValue');
const welcomedSrc = layoutSrc.slice(start, layoutSrc.indexOf('\n}\n', start));

describe('Members: Welcomed is plain profile text (#2807)', () => {
  it('wears no badge style', () => {
    expect(start).toBeGreaterThan(-1);
    expect(welcomedSrc).not.toContain('listNameBadge');
    expect(welcomedSrc).not.toContain('background');
    expect(welcomedSrc).toContain('profileInlineValueStyle');
  });

  it('takes the Profile value text and no background', () => {
    expect(profileInlineValueStyle.fontSize).toBe(formValueStyle.fontSize);
    expect(profileInlineValueStyle.color).toBe(formValueStyle.color);
    expect(profileInlineValueStyle.background).toBeUndefined();
  });

  it('leaves the New Member chip as it was', () => {
    expect(newMemberChipStyle(true).background).toBe(listNameBadgeAccentStyle.background);
    expect(newMemberChipStyle(true).color).toBe(listNameBadgeAccentStyle.color);
  });
});
