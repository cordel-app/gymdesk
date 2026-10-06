import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  emptyGoalForm,
  formForAssignableGoal,
  goalSummaryLine,
  newGoalForm,
  toGoalUpdatePayload,
} from '../../../apps/member/src/lib/memberGoals';

// #1115 — **Personal Goal cards** in the Members App: one card per goal,
// collapsed by default, with creation and editing **inline in the card** rather
// than in a modal dialog.
//
// This gate lives in the API suite for #1009's reason: CI runs `npm test` in
// `api/` only, so a rule that has to hold on every push belongs here even when
// what it guards is a frontend. The Members App's own suite
// (`apps/member/src/test/my-goals.test.ts`) covers the page in full; this one
// pins the four things the ticket is *about*, so a later edit cannot quietly
// put either form back in an overlay or give the card a second chrome.
//
// `lib/memberGoals.ts` is importable here because its only import is a `type`
// (the same reason `goal-reading-chart.unit.test.ts` can read it).

const MEMBER_SRC = join(__dirname, '..', '..', '..', 'apps', 'member', 'src');

function source(...parts: string[]): string {
  return readFileSync(join(MEMBER_SRC, ...parts), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const pageSrc = source('app', '[locale]', 'goals', 'page.tsx');
const cardSrc = source('components', 'MemberGoalCard.tsx');

describe('#1115 a goal is created and edited in its own card, never in a modal', () => {
  it('renders both forms inside the card component', () => {
    expect(pageSrc).toContain('<MemberGoalCard');
    expect(pageSrc).toContain("goalForm('add')");
    expect(pageSrc).toContain("goalForm('edit', goal)");
  });

  /**
   * The only overlays left on this screen are the two that are **not** forms
   * over a goal's own fields: #1037's Add reading and the removal confirmation.
   * A third one would be the modal §2/§3 rules out.
   */
  it('keeps exactly the two dialogs that are not a goal form', () => {
    const dialogs = pageSrc.match(/<MemberDialog/g) ?? [];
    expect(dialogs).toHaveLength(2);
    expect(pageSrc).toContain('labelledBy="goal-reading-title"');
    expect(pageSrc).toContain('labelledBy="goal-remove-title"');
  });

  it('offers no add or edit affordance that opens an overlay', () => {
    // The add CTA and the menu's Edit both set an inline editing state; neither
    // reaches for a dialog.
    expect(pageSrc).toContain("setEditing({ kind: 'add' })");
    expect(pageSrc).toContain("setEditing({ kind: 'edit', goal })");
    expect(pageSrc).not.toContain('goal-dialog-title');
  });
});

describe('#1115 the card has one chrome, and it decides nothing', () => {
  it('owns the header, the caret and the contextual menu', () => {
    expect(cardSrc).toContain('aria-expanded={expanded}');
    expect(cardSrc).toContain('aria-haspopup="menu"');
    expect(cardSrc).toContain('role="menuitem"');
    // §4 — the menu is a sibling of the toggling header, not a child of it.
    expect(cardSrc).toContain('{menu && <CardMenu');
  });

  it('resolves no locale key and spells no colour (#932, #983)', () => {
    expect(cardSrc).not.toContain('useTranslations');
    expect(cardSrc).not.toMatch(/\bt\(/);
    expect(cardSrc.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(cardSrc).toContain("from '@/lib/memberChrome'");
  });

  it('is collapsed by default, and opening one fetches nothing (#955)', () => {
    expect(pageSrc).toContain('useState<Record<number, boolean>>({})');
    expect(pageSrc).toContain('expanded={Boolean(expanded[goal.id])}');
    const toggle = pageSrc.slice(pageSrc.indexOf('function toggleCard'));
    expect(toggle.slice(0, toggle.indexOf('\n  }'))).not.toContain('apiFetch');
  });
});

describe('#1115 what the inline form holds', () => {
  it('starts a draft on today, which stays editable (§2)', () => {
    const now = new Date('2026-09-22T12:00:00.000Z');
    expect(newGoalForm(now)).toEqual({ ...emptyGoalForm, start_date: '2026-09-22' });
    expect(pageSrc).toContain('value={form.start_date}');
  });

  it('keeps what the member already typed when they pick the goal', () => {
    const draft = { ...newGoalForm(new Date('2026-09-22T12:00:00.000Z')), notes: 'summer' };
    expect(formForAssignableGoal(
      { id: 4, slug: 'weight_loss', name: 'Weight Loss', description: null, target_value: 3, target_unit: 'kg' },
      draft,
    )).toEqual({ ...draft, personal_goal_id: '4', target_value: '3', target_unit: 'kg' });
  });

  /**
   * §1 — the unit is the Gym Goal's, so it is shown rather than asked for. Which
   * is also why a cleared target takes it with it: `chk_mpgoal_target_unit`
   * refuses a unit qualifying nothing and the member has no field to fix.
   */
  it('shows the unit read-only and drops it with the value it qualified', () => {
    const form = pageSrc.slice(pageSrc.indexOf('function goalForm('), pageSrc.indexOf('if (loading)'));
    expect(form).toContain('goals.field_unit');
    expect(form).not.toMatch(/value=\{form\.target_unit\}/);
    expect(toGoalUpdatePayload({ ...emptyGoalForm, target_unit: 'kg' }).target_unit).toBeNull();
    expect(toGoalUpdatePayload({ ...emptyGoalForm, target_value: '0', target_unit: 'kg' }).target_unit).toBe('kg');
  });

  it('joins the header summary in the lib, leaving out what is absent (§1)', () => {
    expect(goalSummaryLine(['Target: 70 kg', '65%'])).toBe('Target: 70 kg · 65%');
    expect(goalSummaryLine([null, '65%'])).toBe('65%');
    expect(goalSummaryLine([null, null])).toBeNull();
  });

  it('has the card\'s own strings in all three languages', () => {
    for (const code of ['en', 'es', 'ca']) {
      const goals = JSON.parse(
        readFileSync(join(MEMBER_SRC, '..', 'locales', 'base', `${code}.json`), 'utf-8'),
      ).goals;
      for (const key of ['summary_target', 'menu_label', 'add', 'edit', 'remove']) {
        expect(goals[key], `${code}.goals.${key}`).toBeTruthy();
      }
      expect(goals.summary_target, code).toContain('{value}');
    }
  });
});
