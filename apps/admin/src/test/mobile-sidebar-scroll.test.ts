import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression tests for #883 — the mobile navigation drawer is bounded to the
// viewport and scrolls its own overflow, so every navigation option stays
// reachable however many groups are expanded.
//
// apps/admin has no component-test infra (see docs/architecture.md's TL;DR), so
// this file scans the source the way member-expanded-profile.test.ts (#797)
// does. What it asserts is the arrangement the fix depends on: a bounded
// wrapper, a panel that fills it rather than declaring a viewport height of its
// own, and exactly one scroll container inside that panel.

const COMPONENTS_DIR = join(__dirname, '..', 'components');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(file: string): string {
  return stripComments(readFileSync(join(COMPONENTS_DIR, file), 'utf-8'));
}

const shellSrc = read('AppShell.tsx');
const sidebarSrc = read('Sidebar.tsx');

/** The contents of AppShell's one <style> block. */
function shellCss(): string {
  const start = shellSrc.indexOf('<style>{`');
  expect(start, 'no <style> block in AppShell').toBeGreaterThan(-1);
  const end = shellSrc.indexOf('`}</style>', start);
  expect(end).toBeGreaterThan(start);
  return shellSrc.slice(start, end);
}

/**
 * The end of a `${…}` interpolation starting at `i`, or `i` itself if that is
 * not where one starts. AppShell's CSS reads SIDEBAR_EXPANDED_WIDTH (#1033), so
 * a brace scan over that block has to step over an interpolation's own closing
 * brace rather than reading it as the end of a rule.
 */
function skipInterpolation(css: string, i: number): number {
  if (css[i] !== '$' || css[i + 1] !== '{') return i;
  const end = css.indexOf('}', i);
  expect(end, 'unterminated interpolation').toBeGreaterThan(-1);
  return end;
}

/** The block of a CSS rule whose selector list starts with `selector`. */
function cssRule(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `no ${selector} rule`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  expect(open).toBeGreaterThan(-1);
  for (let i = open + 1; i < css.length; i++) {
    const skipped = skipInterpolation(css, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (css[i] === '}') return css.slice(open + 1, i);
  }
  throw new Error(`unterminated ${selector} rule`);
}

/** The body of the `max-width: 768px` media query — the mobile half. */
function mobileMediaQuery(css: string): string {
  const at = css.indexOf('@media (max-width: 768px)');
  expect(at, 'no mobile media query').toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const skipped = skipInterpolation(css, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (css[i] === '{') depth++;
    if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('unterminated mobile media query');
}

describe('mobile sidebar: bounded drawer (#883)', () => {
  it('constrains the drawer to the viewport below the top bar', () => {
    const mobile = mobileMediaQuery(shellCss());
    const wrapper = cssRule(mobile, '.sidebar-wrapper');
    expect(wrapper).toContain('position: fixed');
    // The available viewport height, not a fixed pixel height.
    expect(wrapper).toContain('height: calc(100vh - var(--gd-top-bar-h, 52px))');
    // …and the dynamic viewport unit where the browser supports it, so a
    // collapsing mobile address bar does not leave the drawer overflowing.
    expect(wrapper).toContain('height: calc(100dvh - var(--gd-top-bar-h, 52px))');
    const dvhAt = wrapper.indexOf('100dvh');
    const vhAt = wrapper.indexOf('100vh');
    expect(dvhAt, '100dvh must come after the 100vh fallback to override it').toBeGreaterThan(vhAt);
    expect(wrapper).toContain('overflow: hidden');
  });

  it('keeps the existing drawer behaviour', () => {
    const mobile = mobileMediaQuery(shellCss());
    expect(cssRule(mobile, '.sidebar-wrapper.sidebar-open')).toContain('left: 0');
    expect(cssRule(mobile, '.mobile-overlay')).toContain('display: block');
    expect(shellSrc).toContain('sidebarOpen ? \' sidebar-open\' : \'\'');
    expect(shellSrc).toContain('onNavigate={() => setSidebarOpen(false)}');
  });

  it('lays the wrapper out as a column so the panel fills it on both breakpoints', () => {
    const css = shellCss();
    // Outside any media query, so desktop keeps a full-height panel too.
    const beforeMobile = css.slice(0, css.indexOf('@media'));
    const wrapper = cssRule(beforeMobile, '.sidebar-wrapper');
    expect(wrapper).toContain('display: flex');
    expect(wrapper).toContain('flex-direction: column');
    // The panel's own flex-shrink: 0 moved up with it — the wrapper is the row
    // flex item, so it is what a wide page must not squeeze.
    expect(wrapper).toContain('flex-shrink: 0');
  });

  it('does not change the desktop sidebar', () => {
    const css = shellCss();
    const at = css.indexOf('@media (min-width: 769px)');
    expect(at).toBeGreaterThan(-1);
    const desktop = css.slice(at);
    expect(cssRule(desktop, '.sidebar-wrapper')).toContain('position: relative');
    // No height or overflow rule is imposed on the desktop wrapper.
    expect(cssRule(desktop, '.sidebar-wrapper')).not.toMatch(/height|overflow/);
    // #1242: the viewport bound lives on the panel, so the nav scrolls on wheel.
    const panel = cssRule(desktop, '.sidebar-panel');
    expect(panel).toContain('position: sticky');
    expect(panel).toMatch(/height: calc\(100dvh/);
  });

  it('freezes the page behind the open drawer, on mobile only', () => {
    const mobile = mobileMediaQuery(shellCss());
    expect(cssRule(mobile, 'body.sidebar-drawer-open')).toContain('overflow: hidden');
    expect(shellSrc).toContain("classList.toggle('sidebar-drawer-open', sidebarOpen)");
    expect(shellSrc).toContain("classList.remove('sidebar-drawer-open')");
  });
});

describe('mobile sidebar: the panel and its one scroll container (#883)', () => {
  it('fills its wrapper instead of declaring a viewport height', () => {
    expect(sidebarSrc).toContain("className=\"sidebar-panel\"");
    expect(sidebarSrc).toContain('flex: 1');
    expect(sidebarSrc).toContain('minHeight: 0');
    // A panel taller than the drawer is what put the bottom items out of reach.
    expect(sidebarSrc).not.toContain('100vh');
    expect(sidebarSrc).not.toContain('100dvh');
  });

  it('scrolls the navigation itself, with native touch scrolling', () => {
    expect(sidebarSrc).toContain("overflowY: 'auto'");
    expect(sidebarSrc).toContain("WebkitOverflowScrolling: 'touch'");
    // A swipe that reaches either end must not chain to the page behind.
    expect(sidebarSrc).toContain("overscrollBehavior: 'contain'");
    // No scrollbar or control is required to reach the bottom items. The
    // scrollbar is hidden in the shell's CSS (#1381), not by overflow.
    expect(sidebarSrc).not.toContain('scrollbar-width');
    expect(sidebarSrc).not.toContain("overflowY: 'hidden'");
    const css = shellCss();
    expect(cssRule(css, '.sidebar-panel > nav')).toContain('scrollbar-width: none');
    expect(cssRule(css, '.sidebar-panel > nav::-webkit-scrollbar')).toContain('display: none');
  });

  it('has exactly one scroll container', () => {
    const scrollers = sidebarSrc.match(/overflowY?: '(auto|scroll)'/g) ?? [];
    expect(scrollers).toHaveLength(1);
  });

  it('does not squeeze expanded groups to fit the viewport', () => {
    // The nav is a block container: a column flex box would shrink the groups
    // rather than overflow, so expanding one would compress the others.
    const navAt = sidebarSrc.indexOf('<nav style={{');
    expect(navAt).toBeGreaterThan(-1);
    const nav = sidebarSrc.slice(navAt, sidebarSrc.indexOf('}}>', navAt));
    expect(nav).not.toContain("display: 'flex'");
    expect(nav).not.toContain('flexDirection');
  });

  it('leaves the navigation structure alone', () => {
    // Groups, ordering, permissions and expand/collapse are untouched by #883.
    expect(sidebarSrc).toContain('filterNavGroups(navigationGroups, userRole, flags)');
    expect(sidebarSrc).toContain('toggleGroup(group.id)');
    expect(sidebarSrc).toContain("sessionStorage.setItem('navGroupsExpanded'");
  });
});
