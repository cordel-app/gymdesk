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

describe('#1826 a goal card has its own Add reading action and no menu or add button', () => {
  it('renders each goal in the card component with its own action', () => {
    expect(pageSrc).toContain('<MemberGoalCard');
    expect(pageSrc).toContain('actions={cardActions(goal)}');
    expect(pageSrc).toContain("openReading(goal, 'reading')");
  });

  /** The only overlay left is the Add reading dialog. */
  it('keeps exactly one dialog, the reading one', () => {
    expect(pageSrc.match(/<MemberDialog/g) ?? []).toHaveLength(1);
    expect(pageSrc).toContain('labelledBy="goal-reading-title"');
  });

  it('has no global Add personal goal button and no contextual menu', () => {
    expect(pageSrc).not.toContain("t('goals.add')");
    expect(pageSrc).not.toContain('menu=');
    expect(pageSrc).not.toContain('cardMenu');
  });
});

describe('#1115 the card has one chrome, and it decides nothing', () => {
  it('owns the header, the caret and the goal action slot, with no menu', () => {
    expect(cardSrc).toContain('aria-expanded={expanded}');
    expect(cardSrc).not.toContain('aria-haspopup');
    expect(cardSrc).toContain('{actions && <div style={styles.actions}>{actions}</div>}');
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
  });

  it('keeps what the member already typed when they pick the goal', () => {
    const draft = { ...newGoalForm(new Date('2026-09-22T12:00:00.000Z')), notes: 'summer' };
    expect(formForAssignableGoal(
      { id: 4, slug: 'weight_loss', name: 'Weight Loss', description: null, target_value: 3, target_unit: 'kg' },
      draft,
    )).toEqual({ ...draft, personal_goal_id: '4', target_value: '3', target_unit: 'kg' });
  });

  // The unit is the Gym Goal's, so a cleared target takes it with it:
  // `chk_mpgoal_target_unit` refuses a unit qualifying nothing.
  it('drops the unit with the value it qualified', () => {
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
      for (const key of ['summary_target', 'add_reading']) {
        expect(goals[key], `${code}.goals.${key}`).toBeTruthy();
      }
      expect(goals.summary_target, code).toContain('{value}');
    }
  });
});
