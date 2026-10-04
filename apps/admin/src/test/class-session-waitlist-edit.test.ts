import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #980 stage 2 — the Waitlist setting on the calendar event's own detail panel.
//
// This repo has no component-test infra for apps/admin (docs/architecture.md's
// TL;DR), so — like stage 1's `class-session-detail-edit.test.ts` — the
// structure is pinned down by scanning the panel source and the locale files.
// What is worth pinning is the half that is a *rule* rather than markup: the
// three states are the column's own and come from one declaration, §3's
// confirmation runs before anything is written and carries the live count, and
// Save must not quietly end the occurrence's inheritance of its Activity
// Type's setting.

const PANEL_PATH = join(__dirname, '..', 'app', '[locale]', 'calendar', 'ClassSessionDetailPanel.tsx');
const MIRROR_PATH = join(__dirname, '..', 'lib', 'waitlistModes.ts');
const ACTIVITY_PAGE_PATH = join(__dirname, '..', 'app', '[locale]', 'activity-types', 'page.tsx');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const panelSrc = stripComments(readFileSync(PANEL_PATH, 'utf-8'));
const mirrorSrc = readFileSync(MIRROR_PATH, 'utf-8');
const activityPageSrc = stripComments(readFileSync(ACTIVITY_PAGE_PATH, 'utf-8'));

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, string>>>;

describe('The Waitlist control (#980 stage 2 §3)', () => {
  it('offers the three states from the one declaration, not a list of its own', () => {
    expect(panelSrc).toContain("from '@/lib/waitlistModes'");
    expect(panelSrc).toContain('WAITLIST_MODES.map');
    // Neither screen may re-spell the vocabulary: both read the mirror, whose
    // server counterpart is `api/src/domain/waitlistMode.ts`.
    expect(activityPageSrc).toContain("from '@/lib/waitlistModes'");
    expect(mirrorSrc).toContain("export const WAITLIST_MODES = ['disabled', 'open', 'closed'] as const;");
    expect(panelSrc).not.toContain("['disabled', 'open', 'closed']");
    expect(activityPageSrc).not.toContain("['disabled', 'open', 'closed']");
  });

  it('is a control in Edit mode only, and a value outside it (#797)', () => {
    const selects = panelSrc.match(/<select[\s\S]*?<\/select>/g) ?? [];
    const waitlistSelects = selects.filter((s) => s.includes('session-waitlist'));
    expect(waitlistSelects).toHaveLength(1);

    const editBlock = panelSrc.slice(panelSrc.indexOf('{editingDetails && ('));
    expect(editBlock).toContain(waitlistSelects[0]);
    // The read-only card still reports the setting, as the effective mode.
    expect(panelSrc).toContain("label={t('event_waitlist')}");
    expect(panelSrc).toContain('waitlist_mode_${session.effective_waitlist_mode}');
  });

  it('says when the value shown is the activity\'s rather than the event\'s own', () => {
    expect(panelSrc).toContain('session.waitlist_mode == null');
    expect(panelSrc).toContain("t('waitlist_inherited')");
  });

  it('compares the draft against the effective mode, not the stored column', () => {
    // The column is nullable and `null` means "follow the Activity Type", so
    // comparing against the occurrence's own value would write the inherited
    // mode onto the occurrence on the first unrelated save and silently end
    // that inheritance.
    const payload = panelSrc.match(/function detailsPayload\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(payload).toContain('draftWaitlistMode !== current.effective_waitlist_mode');
    expect(payload).not.toContain('draftWaitlistMode !== current.waitlist_mode');
    expect(panelSrc).toContain('setDraftWaitlistMode(session.effective_waitlist_mode)');
  });

  it('asks before the save that empties the queue, and only for that one', () => {
    const closes = panelSrc.match(/function saveClosesWaitlist\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    // `closed` keeps everybody's place, so it needs no warning — the
    // distinction is the shared module's, not this panel's.
    expect(closes).toContain('waitlistModeClosesQueue(draftWaitlistMode)');
    expect(closes).toContain('!waitlistModeClosesQueue(current.effective_waitlist_mode)');

    const save = panelSrc.match(/async function handleSaveDetails\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    // The confirmation gate comes before the request, so nothing is written
    // until the admin has seen the count.
    const gateAt = save.indexOf('setConfirmDisableWaitlist(true)');
    const fetchAt = save.indexOf('apiFetch(');
    expect(gateAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(gateAt);
  });

  it('carries the live waiting count in the confirmation (§3)', () => {
    expect(panelSrc).toContain("t('waitlist_disable_confirm_count', { count: waitlist.length })");
    // The count comes from the waiting list the panel already loaded, not a
    // second read of it.
    expect(panelSrc).toContain("t('waitlist_disable_confirm_title')");
    expect(panelSrc).toContain("t('waitlist_disable_confirm_message')");
  });

  it('invalidates a confirmation the admin has moved away from', () => {
    const select = (panelSrc.match(/<select[\s\S]*?<\/select>/g) ?? [])
      .find((s) => s.includes('session-waitlist')) ?? '';
    expect(select).toContain('setConfirmDisableWaitlist(false)');
  });

  it('rides the same single request as the rest of the form (§9)', () => {
    const save = panelSrc.match(/async function handleSaveDetails\(\)[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect((save.match(/apiFetch\(/g) ?? []).length).toBe(1);
    expect(save).toContain('/class-sessions/${sessionId}');
    // No waitlist route of its own, and no per-member call to clear the queue:
    // emptying it is the server's, inside the same transaction.
    expect(panelSrc).not.toContain('/waitlist-mode');
    expect(panelSrc).not.toMatch(/method: 'DELETE'[\s\S]{0,80}waitlist/);
  });

  it('declares no colour of its own (#912/#954)', () => {
    expect(panelSrc).not.toMatch(/#6c63ff/i);
    expect(panelSrc).toContain('primaryBtnSmall()');
  });

  it('has every new label in all three locales', () => {
    const keys = [
      'event_waitlist', 'waitlist_inherited',
      'waitlist_mode_disabled', 'waitlist_mode_open', 'waitlist_mode_closed',
      'waitlist_mode_hint_disabled', 'waitlist_mode_hint_open', 'waitlist_mode_hint_closed',
      'waitlist_disable_confirm_title', 'waitlist_disable_confirm_message',
      'waitlist_disable_confirm_count', 'waitlist_disable_confirm_action',
    ];
    for (const key of keys) {
      for (const code of LOCALE_CODES) {
        const value = locales[code].calendar?.[key];
        expect(value, `${code}.calendar.${key} is missing`).toBeTruthy();
      }
    }
  });

  it('words the count with ICU plurals rather than one string per number', () => {
    for (const code of LOCALE_CODES) {
      expect(locales[code].calendar.waitlist_disable_confirm_count).toContain('{count, plural,');
    }
  });
});
