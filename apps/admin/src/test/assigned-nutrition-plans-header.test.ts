import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #810 — "Nutrition Plans" becomes "Assigned Nutrition Plans", and the card
// header carries the assignment plus the record's standard metadata.
//
// Two things were missing from the collapsed card. The member the plan is
// assigned to was rendered as a small grey aside, so the header read as "a plan"
// rather than "this plan, assigned to this member"; and Created By was only
// reachable through the Details modal, although Created At and the status badge
// were already in the header.
//
// The fix keeps the platform's own conventions: the member reuses the plan
// name's typography (one `headerTitleStyle` both cells spread, so they cannot
// drift), Created By renders as `created_by_name ?? '—'` the way every other
// list does, and the status stays the shared `StatusBadge`. Nothing about the
// plan's data, its inline editor or its ⋮ menu changes — the ticket is a naming
// and presentation change (§6).
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like training-plans-list-header.test.ts (#724) — this pins the
// structure down by scanning the sources and the locale files.

const SRC = join(__dirname, '..');
const PAGE_PATH = join(SRC, 'app', '[locale]', 'nutrition', 'nutrition-plans', 'page.tsx');
const NAV_PATH = join(SRC, 'config', 'navigationGroups.ts');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

/** What the renamed section is called, per locale (§1: one wording only). */
const SECTION_LABEL: Record<(typeof LOCALE_CODES)[number], string> = {
  en: 'Assigned Nutrition Plans',
  es: 'Planes de nutrición asignados',
  ca: 'Plans de nutrició assignats',
};

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));
const navSrc = stripComments(readFileSync(NAV_PATH, 'utf-8'));

/** The collapsed header — the row the card shows before it is expanded. */
const collapsedHeaderSrc = pageSrc.match(
  /<div\s*\n\s*onClick=\{onToggleExpand\}[\s\S]*?\n {8}<\/div>\n/,
)?.[0] ?? '';

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, unknown>>>;

describe('Assigned Nutrition Plans: rename and card header (#810)', () => {
  it('locates the collapsed header it scans', () => {
    expect(collapsedHeaderSrc, 'the collapsed card header could not be located').not.toBe('');
  });

  // ── §1 Rename ───────────────────────────────────────────────────────────────

  it('renames the sidebar entry and the page title to the same wording', () => {
    // The nav entry keeps its key — only what the key resolves to changes.
    expect(navSrc).toMatch(/href: '\/\{\{locale\}\}\/nutrition\/nutrition-plans',\s*\n\s*labelKey: 'nav\.nutrition_plans',/);
    expect(pageSrc).toMatch(/<h1 style=\{\{ margin: 0 \}\}>\{t\('nutrition_plans\.title'\)\}<\/h1>/);
    for (const code of LOCALE_CODES) {
      expect(locales[code].nav.nutrition_plans, `${code}.json nav.nutrition_plans`).toBe(SECTION_LABEL[code]);
      expect(locales[code].nutrition_plans.title, `${code}.json nutrition_plans.title`).toBe(SECTION_LABEL[code]);
      // §1: no other naming variation — sidebar and heading are the same string.
      expect(locales[code].nutrition_plans.title).toBe(locales[code].nav.nutrition_plans);
    }
  });

  // ── §2 The assignment ───────────────────────────────────────────────────────

  it('shows the member next to the plan name, at the same size and weight', () => {
    // #1011 stage 4 gave this row a `LIST_COLUMNS` declaration, so each cell
    // reaches its column through the shared class map as well as carrying its
    // own typography. Same claim, one indirection later.
    expect(collapsedHeaderSrc).toMatch(
      /className=\{CELL_CLASS\.name\}[^>]*style=\{nameCellStyle\}>\{plan\.name\}<\/span>[\s\S]*?className=\{CELL_CLASS\.member\}[^>]*style=\{memberCellStyle\}>\{plan\.member_name\}<\/span>/,
    );
    // …and the Member is what `Q1` keeps on a phone beside the plan's own name,
    // because this list is member-related.
    expect(pageSrc).toMatch(/key: 'member', width: \d+, grow: \d+, mobile: 'keep'/);
    // One typography declaration, spread by both cells, so they cannot drift.
    expect(pageSrc).toMatch(/const headerTitleStyle: React\.CSSProperties = \{ fontWeight: 600, fontSize: 15 \};/);
    for (const cell of ['nameCellStyle', 'memberCellStyle']) {
      expect(pageSrc).toMatch(new RegExp(`const ${cell}: React\\.CSSProperties = \\{\\s*\\n\\s*\\.\\.\\.headerTitleStyle,`));
    }
    // The member is no longer a small grey aside.
    expect(collapsedHeaderSrc).not.toMatch(/color: '#666'/);
  });

  // ── §3–§5 Standard record metadata ──────────────────────────────────────────

  it('carries Created At, Created By and Status in the header', () => {
    for (const marker of [
      'formatDate(plan.created_at, locale)',
      "{plan.created_by_name ?? '—'}",
      'label={t(`status.${plan.status}`)}',
    ]) {
      expect(collapsedHeaderSrc, `the header no longer renders ${marker}`).toContain(marker);
    }
    // The status is the shared badge, not a treatment invented for this screen.
    expect(collapsedHeaderSrc).toMatch(/<StatusBadge status=\{plan\.status\}/);
    expect(pageSrc).toMatch(/import \{ StatusBadge \} from '@\/components\/StatusBadge'/);
    // Created At keeps the page's own date formatter, and the metadata cells
    // share one style rather than restating a size and a colour each.
    expect(pageSrc).toMatch(/const metaCellStyle: React\.CSSProperties = \{\s*\n\s*fontSize: 13, color: '#888'/);
    expect([...collapsedHeaderSrc.matchAll(/metaCellStyle/g)].length).toBeGreaterThanOrEqual(3);
  });

  it('reads the metadata off the row the list already returns', () => {
    // No second fetch for the header: these are fields of the list payload.
    for (const field of ['created_at: string;', 'created_by_name: string | null;']) {
      expect(pageSrc, `MemberNutritionPlan no longer declares ${field}`).toContain(field);
    }
  });

  // ── §6 Everything else is untouched ─────────────────────────────────────────

  it('leaves expansion, the ⋮ menu and the inline editor alone', () => {
    expect(collapsedHeaderSrc).toMatch(/onClick=\{onToggleExpand\}/);
    expect(collapsedHeaderSrc).toMatch(/\{expanded \? '▼' : '▶'\}/);
    expect(collapsedHeaderSrc).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    expect(collapsedHeaderSrc).toMatch(/<ContextMenu ariaLabel=\{t\('nutrition_plans\.col_actions'\)\} items=\{menuItems\} \/>/);
    // The day count the header already showed is still there.
    expect(collapsedHeaderSrc).toContain("t('nutrition_plans.day_count', { count: plan.day_count })");
    // The ⋮ menu still opens the inline form, and it still submits the same payload.
    expect(pageSrc).toMatch(/\{ label: t\('nutrition_plans\.edit'\), onClick: onEdit, disabled: !canWrite, title: roTitle \}/);
    expect(pageSrc).toMatch(/const body = \{ name: editForm\.name\.trim\(\), description: editForm\.description\.trim\(\) \|\| null, start_date: editForm\.start_date \|\| null \};/);
    for (const handler of ['handleDuplicate', 'async function complete()', 'async function del()']) {
      expect(pageSrc, `${handler} is gone`).toContain(handler);
    }
    // The member filter still drives the list query.
    expect(pageSrc).toMatch(/params\.set\('member_id', memberFilter\)/);
    // The Details view still offers View Audit Log (CLAUDE.md).
    expect(pageSrc).toMatch(/<ViewAuditLogButton entityType="member_nutrition_plan" entityId=\{plan\.id\}/);
  });
});
