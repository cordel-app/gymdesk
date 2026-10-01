import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// #930 — the Center selector is the Calendar's, not the application header's.
//
// It used to sit in `TopHeader`, so every section of the admin app — Members
// above all — showed a dropdown that looked like a selection they obeyed, and
// Members never did: that page has had its own `All centers` filter all along.
// The control moves into the Calendar's filter bar and, for the first time,
// narrows the calendar itself.
//
// `apps/admin` has no component test infrastructure, so this is a source scan,
// the same shape as `spaces-activities-removed.test.ts`.

const SRC = join(__dirname, '..');
const TOP_HEADER = join(SRC, 'components', 'TopHeader.tsx');
const CALENDAR_PAGE = join(SRC, 'app', '[locale]', 'calendar', 'page.tsx');
const CENTER_FILTER = join(SRC, 'app', '[locale]', 'calendar', 'CalendarCenterFilter.tsx');
const MEMBERS_PAGE = join(SRC, 'app', '[locale]', 'members', 'page.tsx');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

// Every file below names the removed control in a comment, so the scans run
// against code with comments stripped.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // JSX comments are `{/* … */}`; the braces survive the block strip above.
    .replace(/\{\s*\}/g, '');
}

const topHeader = stripComments(readFileSync(TOP_HEADER, 'utf-8'));
const calendarPage = stripComments(readFileSync(CALENDAR_PAGE, 'utf-8'));
const centerFilter = stripComments(readFileSync(CENTER_FILTER, 'utf-8'));
const membersPage = stripComments(readFileSync(MEMBERS_PAGE, 'utf-8'));

const locales = Object.fromEntries(
  LOCALE_CODES.map((code) => [
    code,
    JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')) as Record<string, any>,
  ]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, any>>;

describe('#930 — no Center selector in the application header (AC1)', () => {
  it('TopHeader renders none and imports none', () => {
    expect(topHeader).not.toContain('CenterSelector');
    expect(topHeader).not.toContain('useCenter');
  });

  it('the header-styled component is gone rather than left unrendered', () => {
    expect(existsSync(join(SRC, 'components', 'CenterSelector.tsx'))).toBe(false);
  });

  it('nothing else in the app renders a header Center dropdown', () => {
    // A deleted file that something still imports is a build error, but a
    // *second* copy of the control would not be — so assert the name is unused.
    const hits = [topHeader, calendarPage, membersPage].filter((s) => s.includes('CenterSelector'));
    expect(hits).toEqual([]);
  });

  it('keeps the other header controls it sat beside', () => {
    for (const control of ['GymSelector', 'LanguagePicker', 'UserButton']) {
      expect(topHeader).toContain(control);
    }
  });
});

describe('#930 — the Calendar owns the Center filter (AC2, AC3)', () => {
  it('the page renders it in its filter bar', () => {
    expect(calendarPage).toContain('<CalendarCenterFilter />');
    expect(calendarPage).toContain("from './CalendarCenterFilter'");
  });

  it('the filter wears the shared filter-bar chrome, not the header band', () => {
    expect(centerFilter).toContain('filterControlStyle');
    expect(centerFilter).toContain('FilterField');
    expect(centerFilter).not.toContain('rgba(255,255,255');
  });

  it('offers an "all centers" choice and one option per center', () => {
    expect(centerFilter).toContain("t('filter_center_all')");
    expect(centerFilter).toContain('centers.map(');
  });

  it('renders nothing for a single-center gym, as the header control did', () => {
    expect(centerFilter).toContain('centers.length <= 1');
  });

  it('drives the one center context rather than a second copy of it', () => {
    // `x-center-id` is what `resolveCenterId()` defaults a write's center from,
    // so forking the state here would have cost multi-center gyms that default.
    expect(centerFilter).toContain("from '@/context/CenterContext'");
    expect(centerFilter).toContain('setActiveCenterId');
  });

  it('narrows the calendar itself, through the list routes own query param', () => {
    expect(calendarPage).toContain("params.set('center_id', String(activeCenterId))");
    // …and the fetch re-runs when the selection changes.
    expect(calendarPage).toMatch(/\[activeGymId, activeCenterId, filterMode, filterId, apiFetch, holidays\]/);
  });

  it('leaves the existing pill filters in place (AC4)', () => {
    for (const mode of ['filter_all', 'filter_space', 'filter_activity_type', 'filter_trainer']) {
      expect(calendarPage.includes(mode) || calendarPage.includes('filter_${mode}')).toBe(true);
    }
  });
});

describe('#930 — the Members list keeps its own center filter (AC5)', () => {
  it('still filters by center itself', () => {
    expect(membersPage).toContain('centerFilter');
    expect(membersPage).toContain("p.set('centerId', centerFilter)");
  });

  it('still reads the center catalogue for that filter and for assignment', () => {
    expect(membersPage).toContain("from '@/context/CenterContext'");
  });
});

describe('#930 — locales', () => {
  it.each(LOCALE_CODES)('%s carries the Calendar filter labels', (code) => {
    const calendar = locales[code].calendar as Record<string, unknown>;
    expect(calendar.filter_center, `calendar.filter_center missing from ${code}.json`).toBeTruthy();
    expect(calendar.filter_center_all, `calendar.filter_center_all missing from ${code}.json`).toBeTruthy();
  });

  it.each(LOCALE_CODES)('%s keeps centers.all_centers, which other pages still use', (code) => {
    expect(locales[code].centers.all_centers).toBeTruthy();
  });
});
