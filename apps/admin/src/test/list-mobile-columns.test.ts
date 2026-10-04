import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LIST_ACTIONS_CELL_CLASS, LIST_MOBILE_COLLAPSE_CLASS, LIST_MOBILE_MEDIA_QUERY,
  LIST_MOBILE_SCROLL_CLASS, LIST_NAME_CELL_CLASS, LIST_NAME_VALUE_CLASS,
  LIST_RESPONSIVE_CSS, LIST_SCROLLER_CLASS, LIST_SECONDARY_CELL_CLASS,
  listCellClass, listScrollerClass,
} from '../components/listChrome';

// #1011 — what the mobile list mechanism *does*. The companion gate in
// `api/src/test/admin-list-mobile-columns.unit.test.ts` (there, because CI runs
// `npm test` in `api/` only) asserts that no list opts out of it.
//
// apps/admin has no component-test infra (see docs/architecture.md's TL;DR), so
// the half that cannot be imported is scanned the way mobile-sidebar-scroll.ts
// (#883) scans AppShell.

const COMPONENTS_DIR = join(__dirname, '..', 'components');

function read(file: string): string {
  return readFileSync(join(COMPONENTS_DIR, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

/** The CSS rules whose selector list mentions `needle`. */
function rulesMentioning(needle: string): string[] {
  const out: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(LIST_RESPONSIVE_CSS)) !== null) {
    if (match[1].includes(needle)) out.push(`${match[1].trim()}{${match[2]}}`);
  }
  return out;
}

describe('a column says what it is on a phone', () => {
  it('maps each behaviour to its one class', () => {
    expect(listCellClass('name')).toBe(LIST_NAME_CELL_CLASS);
    expect(listCellClass('actions')).toBe(LIST_ACTIONS_CELL_CLASS);
    expect(listCellClass('secondary')).toBe(LIST_SECONDARY_CELL_CLASS);
    // A kept column needs no class: it is simply never hidden.
    expect(listCellClass('keep')).toBe('');
  });

  it('defaults to secondary, so a column that says nothing is not forced onto the row', () => {
    expect(listCellClass()).toBe(LIST_SECONDARY_CELL_CLASS);
  });

  it('gives the list one wrapper per behaviour of its secondary columns', () => {
    expect(listScrollerClass('collapse')).toBe(`${LIST_SCROLLER_CLASS} ${LIST_MOBILE_COLLAPSE_CLASS}`);
    expect(listScrollerClass('scroll')).toBe(`${LIST_SCROLLER_CLASS} ${LIST_MOBILE_SCROLL_CLASS}`);
  });
});

describe('the stylesheet', () => {
  it('exists only below the breakpoint, so desktop is untouched (§4)', () => {
    expect(LIST_RESPONSIVE_CSS).toContain(`@media ${LIST_MOBILE_MEDIA_QUERY}`);
    // One top-level block: every rule is inside the media query, none beside it.
    expect(LIST_RESPONSIVE_CSS.match(/@media/g)).toHaveLength(1);
    const body = LIST_RESPONSIVE_CSS.slice(LIST_RESPONSIVE_CSS.indexOf('{') + 1);
    expect(body.trim().endsWith('}')).toBe(true);
    expect(body.replace(/\}\s*$/, '')).not.toContain('}\n}');
  });

  it('mirrors AppShell’s own breakpoint rather than declaring a second one', () => {
    expect(read('AppShell.tsx')).toContain('@media (max-width: 768px)');
    expect(LIST_MOBILE_MEDIA_QUERY).toBe('(max-width: 768px)');
  });

  it('hides a secondary column only where its value is one tap away', () => {
    const hidden = rulesMentioning(LIST_SECONDARY_CELL_CLASS);
    expect(hidden).toHaveLength(1);
    // Inline styles are what every cell carries, so only !important wins.
    expect(hidden[0]).toContain('display: none !important');
    // …and only under the collapse wrapper: a flat list has nowhere to read a
    // hidden value, which is why it scrolls instead (`Q2 scroll`).
    expect(hidden[0]).toContain(LIST_MOBILE_COLLAPSE_CLASS);
  });

  it('never hides the name or the actions', () => {
    for (const cls of [LIST_NAME_CELL_CLASS, LIST_NAME_VALUE_CLASS, LIST_ACTIONS_CELL_CLASS]) {
      for (const rule of rulesMentioning(cls)) expect(rule).not.toContain('display: none');
    }
  });

  it('truncates the name instead, with no horizontal page scroll', () => {
    const name = rulesMentioning(LIST_NAME_VALUE_CLASS).join('\n');
    expect(name).toContain('text-overflow: ellipsis');
    expect(name).toContain('white-space: nowrap');
    expect(name).toMatch(/max-width:\s*\d+vw/);
    // Whatever is left over scrolls inside the list's own wrapper.
    expect(rulesMentioning(LIST_SCROLLER_CLASS).join('\n')).toContain('overflow-x: auto');
  });

  it('pins the identity and the actions to the edges of a scrolling row', () => {
    const pinned = rulesMentioning(LIST_MOBILE_SCROLL_CLASS).join('\n');
    expect(pinned).toContain('position: sticky');
    expect(pinned).toContain('left: 0');
    expect(pinned).toContain('right: 0');
    // The table may grow past the wrapper, which is what gives the block
    // between the two pinned cells somewhere to scroll.
    expect(pinned).toContain('width: auto !important');
  });

  it('paints a pinned cell the surface the row already is', () => {
    // Read from listChrome's own constants (#724), never respelled: a pinned
    // cell a different white from its row is what a second literal looks like.
    expect(LIST_RESPONSIVE_CSS).toContain('var(--gd-card-bg, #ffffff)');
    expect(LIST_RESPONSIVE_CSS).toContain('var(--gd-app-bg, #f0f0f0)');
    expect(LIST_RESPONSIVE_CSS).toContain('var(--gd-border, #e5e7eb)');
  });
});

describe('the sheet is mounted once', () => {
  it('by AppShell, for every screen', () => {
    const shell = read('AppShell.tsx');
    expect(shell).toContain("import { ListResponsiveStyles } from './ListResponsiveStyles'");
    expect(shell.match(/<ListResponsiveStyles \/>/g)).toHaveLength(1);
  });

  it('and the component declares no rules of its own', () => {
    const styles = read('ListResponsiveStyles.tsx');
    expect(styles).toContain('<style>{LIST_RESPONSIVE_CSS}</style>');
    expect(styles).not.toContain('@media');
    expect(styles).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});

describe('DataTable reads the declaration', () => {
  const table = read('DataTable.tsx');

  it('wraps the table so the scroll stays inside the list', () => {
    expect(table).toContain('<div className={scroller}>');
  });

  it('derives the secondary behaviour from whether the row expands', () => {
    // A row that expands reads its hidden columns one tap below itself; a flat
    // row has nowhere to read them, so they stay and the middle scrolls.
    expect(table).toContain("listScrollerClass(expandable ? 'collapse' : 'scroll')");
  });

  it('puts the column’s class on both halves of the column', () => {
    expect(table.match(/className=\{listCellClass\(col\.mobile\)\}/g)).toHaveLength(2);
  });

  it('truncates the name cell and keeps its full value in the title', () => {
    expect(table).toContain(`<div className={LIST_NAME_VALUE_CLASS}>{value}</div>`);
    expect(table).toContain("title={col.mobile === 'name' ? col.title?.(row) : undefined}");
  });
});
