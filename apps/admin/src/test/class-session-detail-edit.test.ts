import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #980 stage 1 — Trainer and Space editable from the calendar event's own
// detail panel.
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like activity-colour-column.test.ts (#676) — the structure is
// pinned down by scanning the panel source and the locale files. What is worth
// pinning here is the half of the ticket that is a *rule* rather than markup:
// §8's read-then-edit split (the panel holds no control until Edit is chosen,
// #797), §9's single atomic request, and §12's "this occurrence only" — the
// panel writes the event's own columns and never the Activity Type's defaults.

const PANEL_PATH = join(__dirname, '..', 'app', '[locale]', 'calendar', 'ClassSessionDetailPanel.tsx');
const PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'calendar', 'page.tsx');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const panelSrc = stripComments(readFileSync(PANEL_PATH, 'utf-8'));
const pageSrc = stripComments(readFileSync(PAGE_PATH, 'utf-8'));

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, string>>>;

describe('Class session detail panel: Edit mode (#980 stage 1)', () => {
  it('offers exactly one entry point into the form', () => {
    // #797: the panel reads until Edit is chosen, and the button is gone while
    // the form is open — a panel offering to open a form it is already
    // showing is the entity rendered twice.
    expect(panelSrc).toContain("{!editingDetails && (");
    expect((panelSrc.match(/openEditDetails/g) ?? []).length).toBe(2); // the declaration and its one caller
    expect(panelSrc).toContain("t('edit_details')");
  });

  it('renders the two fields as controls only in Edit mode', () => {
    const selects = panelSrc.match(/<select[\s\S]*?<\/select>/g) ?? [];
    const detailSelects = selects.filter((s) => s.includes('session-trainer') || s.includes('session-space'));
    expect(detailSelects).toHaveLength(2);

    // Both live inside the `editingDetails &&` block, so neither can be
    // reached from the read-only card.
    const editBlock = panelSrc.slice(panelSrc.indexOf('{editingDetails && ('));
    for (const select of detailSelects) {
      expect(editBlock).toContain(select);
    }
  });

  it('saves every field in one request to the one session route (§9)', () => {
    const save = panelSrc.match(/async function handleSaveDetails\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(save).toContain("method: 'PUT'");
    expect(save).toContain('/class-sessions/${sessionId}');
    // The body is built by `detailsPayload()` since #980 stage 2 added the
    // Waitlist to the same form — the point of the assertion is that the
    // fields go in *one* body, not which function assembles it.
    const payload = panelSrc.match(/function detailsPayload\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(payload).toContain('trainer_membership_id');
    expect(payload).toContain('space_id');
    expect(payload).toContain('waitlist_mode');
    // One request, not one per field: a partial save is what §9 forbids.
    expect((save.match(/apiFetch\(/g) ?? []).length).toBe(1);
  });

  it('writes the occurrence only — no activity-type route is called (§12)', () => {
    const save = panelSrc.match(/async function handleSaveDetails\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(save).not.toContain('/activity-types');
    expect(panelSrc).not.toContain('at.waitlist_mode');
    expect(panelSrc).not.toContain('default_trainer_membership_id');
    expect(panelSrc).not.toContain('default_space_id');
  });

  it('sends only what the admin changed', () => {
    const payload = panelSrc.match(/function detailsPayload\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    const save = panelSrc.match(/async function handleSaveDetails\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    // A space the gym has since deactivated is still displayed, so re-sending
    // the stored value on an unrelated edit would 400 the save.
    expect(payload).toContain('current.trainer_membership_id ?? null');
    expect(payload).toContain('current.space_id ?? null');
    expect(save).toContain('Object.keys(body).length === 0');
  });

  it('refreshes the panel and leaves Edit mode after a successful save (§9)', () => {
    const save = panelSrc.match(/async function handleSaveDetails\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(save).toContain('setEditingDetails(false)');
    expect(save).toContain('onMutated()');
    expect(save).toContain('await load()');
  });

  it('reports a slot conflict as its own line rather than a raw error', () => {
    const save = panelSrc.match(/async function handleSaveDetails\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(save).toContain('SLOT_CONFLICT_CODES.includes(code)');
    expect(save).toContain("t('details_blocked_slot')");
  });

  it('takes its lookups from the page rather than fetching them again', () => {
    expect(panelSrc).toContain('spaces: Space[]');
    expect(panelSrc).toContain('trainers: Trainer[]');
    expect(pageSrc).toContain('spaces={spaces}');
    expect(pageSrc).toContain('trainers={trainers}');
    // The panel's own fetches stay what they were: the session and its bookings.
    const fetched = panelSrc.match(/apiFetch<[^>]+>\(`\/[a-z-]+/g) ?? [];
    expect(new Set(fetched.map((f) => f.split('`/')[1]))).toEqual(new Set(['class-sessions', 'bookings']));
  });

  it('declares no colour of its own for the Save/Cancel pair (#912/#954)', () => {
    expect(panelSrc).toContain('primaryBtnSmall()');
    expect(panelSrc).toContain('secondaryBtnSmall');
    expect(panelSrc).not.toMatch(/#6c63ff/i);
  });

  it('keeps the Professional Service a value, since its PUT is a later stage', () => {
    // `Q1 multi`: the relation is modelled once, with #973's. A control the
    // route cannot carry does not belong in the form (#974).
    expect(panelSrc).toContain("t('event_professional_service')");
    expect(panelSrc).not.toContain('professional_service_id:');
  });

  it('has every new label in all three locales', () => {
    for (const key of ['edit_details', 'details_blocked_slot', 'event_professional_service', 'event_covering_trainer']) {
      for (const code of LOCALE_CODES) {
        const value = locales[code].calendar?.[key];
        expect(value, `${code}.calendar.${key} is missing`).toBeTruthy();
      }
    }
  });
});
