// #884: an icon on every first-level sidebar entry.
//
// The sidebar's first level is the collapsible group header (MEMBERSHIP,
// CALENDAR, …) — its items are the second level and deliberately stay
// text-only. The icon is named in the nav config (`icon: 'users'`) and drawn by
// the registry in `components/icons/NavIcons.tsx`, so nothing branches on a
// group id or a label to choose one.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like language-picker-header-chrome.test.ts (#808) — the parts that
// are JSX are pinned down by scanning the component sources; the mapping itself
// is asserted directly, since both halves of it are plain data modules.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { navigationGroups } from '@/config/navigationGroups';
import { NAV_ICON_NAMES, NAV_ICON_SIZE, NAV_ICON_STROKE } from '@/components/icons/navIconNames';

const COMPONENTS = join(__dirname, '..', 'components');
const iconsSrc = readFileSync(join(COMPONENTS, 'icons', 'NavIcons.tsx'), 'utf-8');
const navGroupSrc = readFileSync(join(COMPONENTS, 'NavGroup.tsx'), 'utf-8');

/** The shell's opening <svg> tag — not the one in the file's own doc comment. */
const svgTag = iconsSrc.match(/<svg\n[\s\S]*?\n\s*>/)![0];

/** The keys of the NAV_ICONS object literal, read out of the source. */
function registryNames(): string[] {
  const body = iconsSrc.match(/NAV_ICONS: Record<NavIconName, NavIconComponent> = \{([\s\S]*?)\n\};/)?.[1];
  expect(body, 'the NAV_ICONS registry could not be located').toBeTruthy();
  return [...body!.matchAll(/^\s*([A-Za-z]+):\s*[A-Za-z]+Icon,$/gm)].map((m) => m[1]);
}

describe('every first-level nav entry names an icon (#884)', () => {
  it('declares one for all nine groups', () => {
    expect(navigationGroups.length).toBe(9);
    for (const group of navigationGroups) {
      expect(NAV_ICON_NAMES as readonly string[], group.id).toContain(group.icon);
    }
  });

  it('gives each section its own icon, so the set identifies rather than decorates', () => {
    const used = navigationGroups.map((g) => g.icon);
    expect(new Set(used).size).toBe(used.length);
  });

  it('keeps the name list and the drawing registry in step', () => {
    expect(registryNames().sort()).toEqual([...NAV_ICON_NAMES].sort());
  });
});

describe('the icons are one coherent set (#884 §4, §7)', () => {
  it('draws every icon through a single shared shell', () => {
    // One <svg> in the file: the shell. Nine hand-tuned svg elements is exactly
    // what "not a collection of individually designed icons" rules out.
    expect(iconsSrc.match(/<svg\n/g)?.length).toBe(1);
    expect(iconsSrc.match(/<IconShell/g)?.length).toBe(NAV_ICON_NAMES.length);
  });

  it('declares the grid, the stroke and the size once', () => {
    expect(svgTag).toContain('viewBox="0 0 24 24"');
    expect(svgTag).toContain('strokeWidth={NAV_ICON_STROKE}');
    expect(svgTag).toContain('strokeLinecap="round"');
    expect(svgTag).toContain('strokeLinejoin="round"');
    expect(svgTag).toContain('width={size}');
    expect(svgTag).toContain('height={size}');
    expect(iconsSrc).toContain('size = NAV_ICON_SIZE');
    // Subordinate to the 14px label, and the same box as the chevron beside it.
    expect(NAV_ICON_SIZE).toBe(16);
    expect(NAV_ICON_STROKE).toBe(1.75);
  });

  it('paints in currentColor and fills nothing, so the active and hover states carry through', () => {
    expect(svgTag).toContain('stroke="currentColor"');
    expect(svgTag).toContain('fill="none"');
    // No icon may restate a colour of its own.
    expect(iconsSrc).not.toMatch(/(stroke|fill)="(?!none|currentColor)/);
    expect(iconsSrc).not.toMatch(/#[0-9a-fA-F]{3,6}"/);
    expect(iconsSrc).not.toMatch(/rgba?\(/);
  });

  it('uses no emoji (#884 §5)', () => {
    for (const src of [iconsSrc, readFileSync(join(__dirname, '..', 'config', 'navigationGroups.ts'), 'utf-8')]) {
      expect(src).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);
    }
  });

  it('is decorative: hidden from screen readers and outside the tab order (#884 §14)', () => {
    expect(svgTag).toContain('aria-hidden="true"');
    expect(svgTag).toContain('focusable="false"');
    // The accessible name stays the navigation label.
    expect(iconsSrc).not.toMatch(/aria-label|role="img"|<title/);
  });
});

describe('the sidebar renders them, and nothing else moves (#884 §11, §15, §16)', () => {
  it('renders the group icon from the config, beside the chevron', () => {
    expect(navGroupSrc).toContain("import { NavIcon } from './icons/NavIcons'");
    expect(navGroupSrc).toContain('<NavIcon name={group.icon} />');
    // Config-driven: the component never picks an icon from an id or a label.
    expect(navGroupSrc).not.toMatch(/NavIcon name="/);
    // Both indicators survive, each with its own job.
    expect(navGroupSrc).toContain('▶');
    expect(navGroupSrc).toContain("transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)'");
  });

  it('gives no icon to the second-level items', () => {
    const items = navGroupSrc.slice(navGroupSrc.indexOf('function renderNavItem'), navGroupSrc.indexOf('const groupContainerStyle'));
    expect(items).not.toContain('NavIcon');
    expect(navGroupSrc.match(/<NavIcon/g)?.length).toBe(1);
  });

  it('keeps every label starting at the same x', () => {
    // A fixed-size svg and a fixed-size chevron, neither allowed to shrink.
    expect(iconsSrc).toContain('flexShrink: 0');
    const chevron = navGroupSrc.match(/width: '16px',[\s\S]*?transition: 'transform/)![0];
    expect(chevron).toContain('flexShrink: 0');
    // The sidebar never overrides the shared size.
    expect(navGroupSrc).not.toMatch(/<NavIcon[^>]*size=/);
  });

  it('spends only the room the icon needs, and never wraps a header', () => {
    // 220px sidebar, uppercase 14px: the longest label ("CONFIGURACIÓN",
    // "ENTRENAMIENTO") fits beside the chevron and the icon at these values.
    expect(navGroupSrc).toContain("padding: '10px 16px'");
    expect(navGroupSrc).toContain("gap: '6px'");
    expect(navGroupSrc).toContain("whiteSpace: 'nowrap'");
    // Typography, colours and the item padding are untouched.
    expect(navGroupSrc).toContain('fontSize: 14');
    expect(navGroupSrc).toContain("letterSpacing: '0.08em'");
    expect(navGroupSrc).toContain("padding: '10px 20px'");
    expect(navGroupSrc).toContain("padding: '8px 20px 8px 36px'");
  });

  it('adds no dependency for nine icons', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(' ');
    expect(deps).not.toMatch(/icon|lucide|heroicons|feather|phosphor|fontawesome/i);
  });
});
