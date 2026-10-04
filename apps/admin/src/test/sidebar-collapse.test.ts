// #1003: the desktop sidebar collapses to icons only, and the parent section's
// icon carries the active treatment the hidden subsection would have carried.
//
// apps/admin has no component-test infra (see docs/architecture.md's TL;DR), so
// this file does what mobile-sidebar-scroll.test.ts (#883) and nav-icons.test.ts
// (#884) do: the pure module is asserted directly, and the parts that are JSX
// are pinned down by scanning the component sources.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DESKTOP_MEDIA_QUERY,
  SIDEBAR_EXPANDED_WIDTH,
  navGroupContainsActivePath,
  sidebarWidth,
} from '@/lib/sidebarCollapse';

const COMPONENTS = join(__dirname, '..', 'components');
const LOCALES = join(__dirname, '..', '..', 'locales', 'base');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const sidebarSrc = stripComments(readFileSync(join(COMPONENTS, 'Sidebar.tsx'), 'utf-8'));
const navGroupSrc = stripComments(readFileSync(join(COMPONENTS, 'NavGroup.tsx'), 'utf-8'));
const shellSrc = stripComments(readFileSync(join(COMPONENTS, 'AppShell.tsx'), 'utf-8'));

describe('the two widths and the preference (#1003 §1, §3, §5)', () => {
  it('keeps the expanded width and narrows to icons only', () => {
    expect(SIDEBAR_EXPANDED_WIDTH).toBe(250);
    expect(SIDEBAR_COLLAPSED_WIDTH).toBeLessThan(SIDEBAR_EXPANDED_WIDTH);
    expect(sidebarWidth(false)).toBe(SIDEBAR_EXPANDED_WIDTH);
    expect(sidebarWidth(true)).toBe(SIDEBAR_COLLAPSED_WIDTH);
  });

  it('applies at the shell\'s own desktop breakpoint, not a second one', () => {
    expect(SIDEBAR_DESKTOP_MEDIA_QUERY).toBe('(min-width: 769px)');
    // AppShell's CSS splits the two layouts at the same pixel.
    expect(shellSrc).toContain('@media (min-width: 769px)');
  });

  it('stores the sidebar preference apart from the group expansion state', () => {
    // A lasting layout preference (localStorage) vs. which groups happen to be
    // open (sessionStorage) — §3 keeps the two independent.
    expect(SIDEBAR_COLLAPSED_STORAGE_KEY).not.toBe('navGroupsExpanded');
    expect(sidebarSrc).toContain('readSidebarCollapsed()');
    expect(sidebarSrc).toContain('writeSidebarCollapsed(next)');
    expect(sidebarSrc).toContain("sessionStorage.setItem('navGroupsExpanded'");
  });
});

describe('which group holds the open page is decided once (#1003 §2)', () => {
  const group = {
    items: [
      { href: '/en/financials/promotions', labelKey: 'nav.promotions' },
      { href: '/en/financials/products', labelKey: 'nav.products' },
    ],
  };

  it('matches a subsection of the group', () => {
    expect(navGroupContainsActivePath(group, '/en/financials/promotions')).toBe(true);
  });

  it('does not match another group\'s page', () => {
    expect(navGroupContainsActivePath(group, '/en/nutrition/nutrition-library')).toBe(false);
  });

  it('is not a prefix match: a section is never the active item itself', () => {
    expect(navGroupContainsActivePath(group, '/en/financials')).toBe(false);
  });

  it('reaches a nested child', () => {
    const nested = {
      items: [{
        href: '/en/nutrition',
        labelKey: 'nav.nutrition',
        children: [{ href: '/en/nutrition/nutrition-library', labelKey: 'nav.nutrition_library' }],
      }],
    };
    expect(navGroupContainsActivePath(nested, '/en/nutrition/nutrition-library')).toBe(true);
  });

  it('is the one rule the sidebar asks, in both modes', () => {
    // Twice: the auto-expand effect and the group header's isAnyChildActive.
    expect(sidebarSrc.match(/navGroupContainsActivePath\(/g)).toHaveLength(2);
    // No page-local copy of the comparison it replaced.
    expect(sidebarSrc).not.toContain('pathname === item.href');
  });
});

describe('the collapse control (#1003 §1, §4)', () => {
  it('is rendered on desktop only', () => {
    expect(sidebarSrc).toContain('{isDesktop && (');
    expect(sidebarSrc).toContain('const collapsed = isDesktop && collapsedPref');
  });

  it('toggles the preference and names itself in both states', () => {
    expect(sidebarSrc).toContain('onClick={() => setCollapsed(!collapsed)}');
    expect(sidebarSrc).toContain("t('nav.expand_sidebar')");
    expect(sidebarSrc).toContain("t('nav.collapse_sidebar')");
    expect(sidebarSrc).toContain('aria-label={collapsed ?');
    expect(sidebarSrc).toContain('aria-expanded={!collapsed}');
  });

  it('wears the sidebar\'s own palette rather than a colour of its own', () => {
    const control = sidebarSrc.slice(sidebarSrc.indexOf('{isDesktop && ('), sidebarSrc.indexOf('<nav style={{'));
    expect(control).toContain('var(--gd-sidebar-hover-bg');
    expect(control).toContain('var(--gd-sidebar-text');
    expect(control).not.toMatch(/#[0-9a-fA-F]{3,6}'/);
  });

  it('adds no second scroll container (#883)', () => {
    const scrollers = sidebarSrc.match(/overflowY?: '(auto|scroll)'/g) ?? [];
    expect(scrollers).toHaveLength(1);
    // The control sits outside the <nav>, so it cannot scroll away.
    expect(sidebarSrc.indexOf('{isDesktop && (')).toBeLessThan(sidebarSrc.indexOf('<nav style={{'));
  });
});

describe('collapsing moves the layout and nothing else (#1003 §1, §4)', () => {
  it('drives the panel width from the shared helper, with a transition', () => {
    expect(sidebarSrc).toContain('width: sidebarWidth(collapsed)');
    expect(sidebarSrc).toContain("transition: 'width 150ms ease-in-out'");
    // Never a hardcoded width beside it.
    expect(sidebarSrc).not.toContain('width: 220');
    expect(sidebarSrc).not.toContain('width: 250');
  });

  it('leaves the mobile drawer exactly as it was (§5)', () => {
    // The collapse is state inside the panel; the preference is ignored below
    // the desktop breakpoint. #1033: the closed drawer parks at the shared
    // expanded width rather than a literal of its own, so widening the sidebar
    // cannot leave a sliver of the drawer on screen.
    expect(shellSrc).not.toContain('collapsed');
    expect(shellSrc).toContain('left: -${SIDEBAR_EXPANDED_WIDTH}px');
  });

  it('keeps every navigation option reachable while collapsed', () => {
    // There is nowhere to show a section's items, so the icon brings the
    // sidebar back and opens that group — it adds to the group state (§3).
    expect(sidebarSrc).toContain('function expandIntoGroup(groupId: string)');
    expect(sidebarSrc).toContain('setCollapsed(false)');
    expect(sidebarSrc).toContain('new Set(prev).add(groupId)');
    expect(sidebarSrc).toContain('collapsed ? expandIntoGroup(group.id) : toggleGroup(group.id)');
  });
});

describe('a collapsed group renders its icon alone (#1003 §2, §4)', () => {
  it('takes the mode as a prop rather than reading the viewport itself', () => {
    expect(navGroupSrc).toContain('collapsed?: boolean');
    expect(navGroupSrc).toContain('collapsed = false');
    expect(sidebarSrc).toContain('collapsed={collapsed}');
  });

  it('hides the chevron, the label and the items', () => {
    expect(navGroupSrc).toContain('{!collapsed && (');
    expect(navGroupSrc).toContain('{!collapsed && label}');
    expect(navGroupSrc).toContain('{!collapsed && (\n        <div style={groupContainerStyle}>');
  });

  it('renders the one shared icon at the one shared size', () => {
    // #884's registry, unchanged: one occurrence, no size override.
    expect(navGroupSrc.match(/<NavIcon/g)).toHaveLength(1);
    expect(navGroupSrc).not.toMatch(/<NavIcon[^>]*size=/);
  });

  it('highlights the parent of the active subsection with the existing treatment', () => {
    expect(navGroupSrc).toContain('const showActiveParent = collapsed && isAnyChildActive');
    const header = navGroupSrc.slice(navGroupSrc.indexOf('const showActiveParent'));
    expect(header).toContain('var(--gd-sidebar-selected-bg');
    expect(header).toContain('var(--gd-sidebar-selected-text');
    expect(header).toContain("'3px solid var(--brand, #6c63ff)'");
    // No colour invented for the collapsed state.
    expect(header).not.toMatch(/#[0-9a-fA-F]{3,6}'/);
  });

  it('is not an active navigation item of its own: the highlight needs the collapse', () => {
    // isAnyChildActive alone must not paint the header — expanded mode keeps
    // the active subsection carrying it, exactly as before (§2).
    expect(navGroupSrc).not.toMatch(/background: isAnyChildActive/);
  });

  it('names the section on hover, since the label is gone (§4)', () => {
    expect(navGroupSrc).toContain('title={collapsed ? label : undefined}');
    expect(navGroupSrc).toContain('aria-label={collapsed ? label : undefined}');
    expect(navGroupSrc).toContain('var(--gd-sidebar-hover-bg');
  });
});

describe('the control is named in every locale (#1003)', () => {
  for (const locale of ['en', 'es', 'ca']) {
    it(`has both keys in ${locale}`, () => {
      const nav = JSON.parse(readFileSync(join(LOCALES, `${locale}.json`), 'utf-8')).nav;
      expect(nav.collapse_sidebar).toBeTruthy();
      expect(nav.expand_sidebar).toBeTruthy();
      expect(nav.collapse_sidebar).not.toBe(nav.expand_sidebar);
    });
  }
});
