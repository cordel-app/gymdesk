import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// #983 — the Members App renders with the theme a gym configured, so a colour
// typed into one of its screens is a value the theme cannot move: that is how a
// gym with a dark brown header and orange accents still saw white cards and
// near-black headings. One module spells every visual value
// (`apps/member/src/lib/memberChrome.ts`, the rule `listChrome.ts` and
// `formChrome.ts` are for the Admin app) and every surface spreads what it
// exports.
//
// This gate lives in the API suite for #1009's reason: CI runs `npm test` in
// `api/` only, so a scan that has to hold on every push belongs here even when
// what it scans is a frontend. The Members App's own suite
// (`apps/member/src/test/members-app-theme-vars.test.ts`) asserts *which*
// setting reaches which surface; this one asserts that nothing bypasses them.

const MEMBER_SRC = join(__dirname, '..', '..', '..', 'apps', 'member', 'src');

/**
 * The three files that may still carry a literal, each for a reason that is
 * about the product rather than about convenience:
 *
 * - `app/[locale]/layout.tsx` — the static `theme-color` meta, read from the
 *   document head before any gym is resolved. It tints the *browser's* chrome
 *   and cannot be a CSS variable at all.
 * - `components/AdminBar.tsx` and `components/ImpersonationBanner.tsx` — the
 *   two bars that tell a superadmin whose account they are looking at. They are
 *   the platform's, deliberately outside the Theme: a gym able to repaint them
 *   could make them disappear into the page it designed.
 */
const ALLOWED = new Set([
  'app/[locale]/layout.tsx',
  'components/AdminBar.tsx',
  'components/ImpersonationBanner.tsx',
]);

/** The one module that is allowed — required — to spell the values. */
const CHROME = 'lib/memberChrome.ts';

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

/** The file with its comments removed, so a comment naming a variable or a
 * retired literal does not read as code. */
function withoutComments(relative: string): string {
  return readFileSync(join(MEMBER_SRC, relative), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

/**
 * The same file (they cite ticket numbers such as `#983`,
 * which look exactly like a three-digit colour) and with every
 * `var(--token, fallback)` expression collapsed, including one nested level:
 * the literal inside a `var()` is that variable's own fallback for the frames
 * before `ThemeProvider`'s effect has run, not a value overriding the theme.
 */
function paintedValues(relative: string): string {
  return withoutComments(relative)
    .replace(/var\(\s*--[a-z0-9-]+\s*,[^()]*\)/g, 'VAR')
    .replace(/var\(\s*--[a-z0-9-]+\s*,\s*VAR\s*\)/g, 'VAR');
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('the Members App paints from the theme (#983)', () => {
  const surfaces = [
    ...walk(join(MEMBER_SRC, 'app'), 'app'),
    ...walk(join(MEMBER_SRC, 'components'), 'components'),
  ];

  it('scans the whole app, so a new screen is covered by default', () => {
    // A sanity check on the walk itself: if it ever returns nothing the
    // assertions below would pass vacuously.
    expect(surfaces.length).toBeGreaterThan(20);
    expect(surfaces).toContain('app/[locale]/page.tsx');
    expect(surfaces).toContain('app/[locale]/calendar/page.tsx');
  });

  it('spells no colour outside lib/memberChrome.ts', () => {
    for (const relative of surfaces) {
      if (ALLOWED.has(relative)) continue;
      const found = paintedValues(relative).match(HEX) ?? [];
      expect(found, `${relative} spells ${found.join(', ')} — add the role to lib/memberChrome.ts instead`).toEqual([]);
    }
  });

  it('keeps the carve-outs to the three files that have a reason', () => {
    // Narrow by construction: the set is asserted rather than merely consulted,
    // so adding a file to it is a decision somebody takes in a review.
    expect([...ALLOWED].sort()).toEqual([
      'app/[locale]/layout.tsx',
      'components/AdminBar.tsx',
      'components/ImpersonationBanner.tsx',
    ]);
  });

  it('never borrows an Admin sidebar colour for a Members App surface', () => {
    // `--gd-sidebar-*` is the Admin sidebar's, and no Members App setting can
    // move it — which is what made the Calendar's filter bar and the event
    // window unthemable (§7).
    for (const relative of surfaces) {
      expect(
        withoutComments(relative),
        `${relative} reads an Admin sidebar variable`,
      ).not.toContain('--gd-sidebar-');
    }
  });

  it('declares every role the app paints with, as the variable that holds it', () => {
    const chrome = readFileSync(join(MEMBER_SRC, CHROME), 'utf-8');
    for (const cssVar of [
      '--gd-app-bg',
      '--gd-card-bg',
      '--gd-text',
      '--gd-text-muted',
      '--gd-border',
      '--gd-color-h1',
      '--gd-color-h2',
      '--gd-color-h3',
      '--gd-members-card-border',
      '--gd-members-card-border-width',
      '--gd-input-bg',
      '--gd-input-border',
      '--gd-primary-btn',
      '--gd-primary-btn-text',
      '--gd-status-success',
      '--gd-status-warning',
      '--gd-status-error',
      '--gd-status-info',
      '--gd-calendar-nav-btn-bg',
      '--gd-members-calendar-modal-bg',
      '--gd-members-calendar-modal-input-bg',
    ]) {
      expect(chrome, `memberChrome.ts reads no ${cssVar}`).toContain(`var(${cssVar}`);
    }
  });
});
