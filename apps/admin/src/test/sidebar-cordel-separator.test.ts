// #1020: a thicker divider above the Cordel section of the sidebar.
//
// apps/admin has no component-test infra (see docs/architecture.md's TL;DR), so
// this file does what nav-icons.test.ts (#884) and sidebar-collapse.test.ts
// (#1003) do: the pure module is asserted directly, and the parts that are JSX
// are pinned down by scanning the component sources.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { navigationGroups } from '@/config/navigationGroups';
import {
  NAV_GROUP_SEPARATOR_WIDTH,
  NAV_ITEM_SEPARATOR_WIDTH,
  NAV_SEPARATOR_COLOR,
  navGroupSeparatorStyle,
  navItemSeparatorStyle,
} from '@/components/navChrome';

const COMPONENTS = join(__dirname, '..', 'components');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const navGroupSrc = stripComments(readFileSync(join(COMPONENTS, 'NavGroup.tsx'), 'utf-8'));
const sidebarSrc = stripComments(readFileSync(join(COMPONENTS, 'Sidebar.tsx'), 'utf-8'));

describe('the two dividers are one declaration (#1020)', () => {
  it('makes the section rule thicker than the standard item separator', () => {
    expect(NAV_GROUP_SEPARATOR_WIDTH).toBeGreaterThan(NAV_ITEM_SEPARATOR_WIDTH);
    expect(navItemSeparatorStyle.borderTop)
      .toBe(`${NAV_ITEM_SEPARATOR_WIDTH}px solid ${NAV_SEPARATOR_COLOR}`);
    expect(navGroupSeparatorStyle(false).borderTop)
      .toBe(`${NAV_GROUP_SEPARATOR_WIDTH}px solid ${NAV_SEPARATOR_COLOR}`);
  });

  it('draws both in the same existing sidebar colour, and introduces none', () => {
    // The rest of the sidebar's chrome is this white alpha over the Theme's own
    // sidebar background; a divider must not add a hue of its own.
    expect(NAV_SEPARATOR_COLOR).toBe('rgba(255,255,255,0.15)');
    expect(navGroupSeparatorStyle(false).borderTop).toContain(NAV_SEPARATOR_COLOR);
    expect(navGroupSeparatorStyle(true).borderTop).toContain(NAV_SEPARATOR_COLOR);
  });

  it('keeps the rule in the collapsed strip, narrowing only its inset', () => {
    // #1003's collapsed sidebar is 64px wide: the expanded 16px inset would
    // leave a stub, so the margin — and nothing else — changes.
    expect(navGroupSeparatorStyle(true).borderTop)
      .toBe(navGroupSeparatorStyle(false).borderTop);
    expect(navGroupSeparatorStyle(true).margin)
      .not.toBe(navGroupSeparatorStyle(false).margin);
  });

  it('is spelled nowhere else — both components read the declaration', () => {
    expect(navGroupSrc).toContain('navGroupSeparatorStyle(collapsed)');
    expect(navGroupSrc).toContain('style={navItemSeparatorStyle}');
    // No second spelling of either line in the components that draw them.
    for (const src of [navGroupSrc, sidebarSrc]) {
      expect(src).not.toContain('rgba(255,255,255,0.15)');
    }
  });
});

describe('which section carries it is navigation config (#1020)', () => {
  it('declares it on the Cordel group and on no other', () => {
    const withSeparator = navigationGroups.filter((g) => g.separatorAbove).map((g) => g.id);
    expect(withSeparator).toEqual(['cordel']);
  });

  it('keeps Cordel last, so the rule separates it from the gym sections above', () => {
    expect(navigationGroups[navigationGroups.length - 1].id).toBe('cordel');
  });

  it('never draws one above the first visible section', () => {
    // The group declares the divider; the sidebar is the only place that knows
    // whether this group is the first one this role can see.
    expect(sidebarSrc).toContain('separatorAbove={!!group.separatorAbove && index > 0}');
  });

  it('changes nothing else about the Cordel item', () => {
    const cordel = navigationGroups.find((g) => g.id === 'cordel')!;
    expect(cordel.requiredRole).toBe('superadmin');
    expect(cordel.labelKey).toBe('nav.groups.cordel');
    expect(cordel.icon).toBe('shield');
  });
});
