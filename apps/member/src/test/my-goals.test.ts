import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SYSTEM_PERSONAL_GOAL_SLUGS,
  emptyGoalForm,
  formForAssignableGoal,
  formForMemberGoal,
  formatGoalTarget,
  goalDisplayName,
  goalFormError,
  goalStatusKey,
  goalStatusToneKey,
  isLiveGoal,
  toGoalCreatePayload,
  toGoalUpdatePayload,
  type MemberGoal,
} from '../lib/memberGoals';
import { statusTone } from '../lib/memberChrome';

// #1036 — **My Goals**: the member manages their own Personal Goal
// assignments, and cannot create a Goal definition.
//
// Everything the page decides is pure and unit-tested directly. The rendering
// has no component-test infra in this repo (no testing-library, no jsdom), so
// the page and its call sites are pinned by scanning their source, exactly as
// `my-nutrition-sections.test.ts` (#932) and `nutrition-food-carousel.test.ts`
// (#722) do.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const PAGE = join(SRC, 'app', '[locale]', 'goals', 'page.tsx');
const HOME = join(SRC, 'app', '[locale]', 'page.tsx');
const DIALOG = join(SRC, 'components', 'MemberDialog.tsx');
const LIB = join(SRC, 'lib', 'memberGoals.ts');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));
const pageSrc = read(PAGE);
const homeSrc = read(HOME);
const dialogSrc = read(DIALOG);
const libSrc = read(LIB);

/** The real `t`: the message when the key is known, the key when it is not. */
function translator(messages: Record<string, string>) {
  return (key: string) => messages[key] ?? key;
}

function goal(overrides: Partial<MemberGoal> = {}): MemberGoal {
  return {
    id: 1,
    personal_goal_id: 7,
    goal_name: 'Weight Loss',
    goal_slug: 'weight_loss',
    target_value: 3,
    target_unit: 'kg',
    start_date: '2026-01-01',
    target_date: null,
    end_date: null,
    status: 'in_progress',
    notes: null,
    deleted_at: null,
    // #1037 — the reading summary every row of `GET /me/personal-goals` carries.
    initial_reading: null,
    initial_reading_at: null,
    latest_reading: null,
    latest_reading_at: null,
    progress_percent: null,
    reading_count: 0,
    ...overrides,
  };
}

describe('a goal is shown under its own label (§2)', () => {
  const t = translator({ 'goals.goal_weight_loss': 'Weight Loss' });

  it('resolves a seeded System goal through its slug', () => {
    expect(goalDisplayName(goal(), t)).toBe('Weight Loss');
  });

  it("falls back to a gym's own goal name, which carries no slug", () => {
    expect(goalDisplayName(goal({ goal_slug: null, goal_name: 'Run a 10k' }), t)).toBe('Run a 10k');
  });

  // next-intl has no `defaultValue` and prints a missing key verbatim, so the
  // fallback is decided before `t()` is called (CLAUDE.md, #812's defect).
  it('never asks t() for a slug outside the seeded set', () => {
    expect(goalDisplayName(goal({ goal_slug: 'invented', goal_name: 'Invented' }), t)).toBe('Invented');
  });

  it('reads the catalogue shape too, so the picker and the card word a goal alike', () => {
    expect(goalDisplayName({ slug: 'weight_loss', name: 'Weight Loss' }, t)).toBe('Weight Loss');
  });

  it('knows exactly the seven System Personal Goals', () => {
    expect([...SYSTEM_PERSONAL_GOAL_SLUGS]).toEqual([
      'weight_loss', 'weight_gain', 'muscle_gain', 'maintenance',
      'performance', 'recovery', 'energy',
    ]);
  });
});

describe('a target reads as a number and its unit (§3)', () => {
  it('composes the value and the unit', () => {
    expect(formatGoalTarget({ target_value: 3, target_unit: 'kg' })).toBe('3 kg');
    expect(formatGoalTarget({ target_value: 70, target_unit: 'Kg' })).toBe('70 Kg');
  });

  it('trims a DECIMAL(10,2)\'s trailing zeros', () => {
    expect(formatGoalTarget({ target_value: 3.0, target_unit: 'kg' })).toBe('3 kg');
    expect(formatGoalTarget({ target_value: 2.5, target_unit: 'kg' })).toBe('2.5 kg');
  });

  // Maintenance is seeded at `0 kg` because a change of zero *is* the goal
  // (#1034 §2), so zero is a target and not an absence.
  it('shows a zero target', () => {
    expect(formatGoalTarget({ target_value: 0, target_unit: 'kg' })).toBe('0 kg');
  });

  it('shows a value with no unit, and nothing at all with no value', () => {
    expect(formatGoalTarget({ target_value: 5, target_unit: null })).toBe('5');
    expect(formatGoalTarget({ target_value: null, target_unit: 'kg' })).toBeNull();
  });
});

describe('which list a goal belongs in (§3, Q4)', () => {
  it('is live while it is neither removed nor finished', () => {
    expect(isLiveGoal(goal())).toBe(true);
  });

  it('is past once it is removed, achieved or abandoned', () => {
    expect(isLiveGoal(goal({ deleted_at: '2026-02-02T10:00:00Z' }))).toBe(false);
    expect(isLiveGoal(goal({ status: 'achieved' }))).toBe(false);
    expect(isLiveGoal(goal({ status: 'abandoned' }))).toBe(false);
  });

  // A removed goal keeps the progress it had (migration 212 keeps the two axes
  // apart), so reading `status` alone would label it *In progress*.
  it('words a removed goal as removed rather than as its stored status', () => {
    expect(goalStatusKey(goal({ deleted_at: '2026-02-02T10:00:00Z' }))).toBe('goals.status_removed');
    expect(goalStatusKey(goal({ status: 'achieved' }))).toBe('goals.status_achieved');
    expect(goalStatusKey(goal({ status: 'abandoned' }))).toBe('goals.status_abandoned');
    expect(goalStatusKey(goal())).toBe('goals.status_in_progress');
  });

  it('takes one of the app\'s own four tones and introduces no fifth', () => {
    expect(statusTone(goalStatusToneKey(goal({ status: 'achieved' })))).toBe('success');
    expect(statusTone(goalStatusToneKey(goal({ status: 'abandoned' })))).toBe('error');
    expect(statusTone(goalStatusToneKey(goal({ deleted_at: 'x' })))).toBe('neutral');
  });
});

describe('the form (§5, §9)', () => {
  it('pre-fills the target the picked Gym Goal carries', () => {
    expect(formForAssignableGoal({ id: 4, slug: 'weight_loss', name: 'Weight Loss', description: null, target_value: 3, target_unit: 'kg' }))
      .toEqual({ ...emptyGoalForm, personal_goal_id: '4', target_value: '3', target_unit: 'kg' });
  });

  it('pre-fills nothing for a Gym Goal with no target of its own', () => {
    expect(formForAssignableGoal({ id: 9, slug: 'performance', name: 'Performance', description: null, target_value: null, target_unit: null }))
      .toEqual({ ...emptyGoalForm, personal_goal_id: '9' });
  });

  // §8 — editing starts from what the member agreed, not from the catalogue.
  it('seeds an edit from the assignment', () => {
    expect(formForMemberGoal(goal({ target_value: 5, target_unit: 'kg', target_date: '2026-06-01', notes: 'summer' })))
      .toEqual({
        personal_goal_id: '7', target_value: '5', target_unit: 'kg',
        start_date: '2026-01-01', target_date: '2026-06-01', notes: 'summer',
      });
  });

  it('asks for a goal only when one is being added', () => {
    expect(goalFormError(emptyGoalForm, { requireGoal: true })).toBe('goals.error_goal_required');
    expect(goalFormError(emptyGoalForm, { requireGoal: false })).toBeNull();
  });

  it('reports every field rule as a locale key, never a sentence', () => {
    const base = { ...emptyGoalForm, personal_goal_id: '4' };
    expect(goalFormError({ ...base, target_value: 'abc' }, { requireGoal: true })).toBe('goals.error_target_number');
    expect(goalFormError({ ...base, target_value: '-1' }, { requireGoal: true })).toBe('goals.error_target_negative');
    expect(goalFormError({ ...base, target_value: '1e12' }, { requireGoal: true })).toBe('goals.error_target_max');
    expect(goalFormError({ ...base, target_unit: 'kg' }, { requireGoal: true })).toBe('goals.error_unit_without_value');
    expect(goalFormError({ ...base, target_value: '3', target_unit: 'x'.repeat(21) }, { requireGoal: true })).toBe('goals.error_unit_length');
    expect(goalFormError({ ...base, start_date: '2026-06-01', target_date: '2026-01-01' }, { requireGoal: true })).toBe('goals.error_dates');
    expect(goalFormError({ ...base, notes: 'n'.repeat(1001) }, { requireGoal: true })).toBe('goals.error_notes_length');
  });

  // A value with no unit is incomplete rather than contradictory, and the one
  // direction `chk_mpgoal_target_unit` refuses is the one checked here.
  it('allows a value with no unit, and a zero target', () => {
    const base = { ...emptyGoalForm, personal_goal_id: '4' };
    expect(goalFormError({ ...base, target_value: '5' }, { requireGoal: true })).toBeNull();
    expect(goalFormError({ ...base, target_value: '0', target_unit: 'kg' }, { requireGoal: true })).toBeNull();
  });

  it('submits an emptied field as an explicit null, so the server does not re-inherit it', () => {
    expect(toGoalCreatePayload({ ...emptyGoalForm, personal_goal_id: '4' })).toEqual({
      personal_goal_id: 4,
      target_value: null, target_unit: null, start_date: null, target_date: null, notes: null,
    });
  });

  // §12 — the assignment's goal is immutable; re-pointing is remove plus add.
  it('never submits personal_goal_id on an edit', () => {
    const payload = toGoalUpdatePayload({ ...emptyGoalForm, personal_goal_id: '4', target_value: '5', target_unit: ' kg ' });
    expect(payload).not.toHaveProperty('personal_goal_id');
    expect(payload.target_value).toBe(5);
    expect(payload.target_unit).toBe('kg');
  });
});

describe('the page reuses the app rather than restating it (§19, §983)', () => {
  it('spells no colour of its own', () => {
    for (const src of [pageSrc, dialogSrc, libSrc]) {
      const hexes = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hexes).toEqual([]);
    }
  });

  it('takes its surfaces, inputs and buttons from memberChrome', () => {
    for (const name of [
      'sectionCardStyle', 'inputStyle', 'primaryButtonStyle',
      'secondaryButtonStyle', 'destructiveButtonStyle', 'statusPillStyle', 'statusTone',
    ]) {
      expect(pageSrc).toContain(name);
    }
  });

  it('renders every dialog through the one shared shell rather than a second overlay', () => {
    expect(pageSrc).toContain('<MemberDialog');
    // Add/Edit, #1037's Add reading, and the removal confirmation — three uses
    // of one shell, not three overlays.
    expect(pageSrc.match(/<MemberDialog/g)).toHaveLength(3);
    expect(pageSrc).not.toContain("position: 'fixed'");
  });

  it('decides nothing about a goal for itself — every rule comes from the lib', () => {
    expect(pageSrc).not.toMatch(/target_value\s*===\s*null\s*\?/);
    expect(pageSrc).not.toMatch(/status\s*===\s*'achieved'/);
    expect(pageSrc).toContain('formatGoalTarget');
    expect(pageSrc).toContain('goalStatusKey');
  });
});

describe('what the member may and may not do (§4, §6, §14, §15)', () => {
  // §6 — the picker is a `<select>` over the gym's catalogue. A text input for
  // a goal's name would be the member creating a definition.
  it('offers a select over the catalogue and no free-text goal name', () => {
    expect(pageSrc).toContain('<select');
    expect(pageSrc).not.toMatch(/name="goal_name"|goal_name:\s*form\./);
  });

  it('never names a member in a request (§15, §18)', () => {
    expect(pageSrc).not.toContain('member_id');
    expect(libSrc).not.toContain('member_id');
  });

  // §14 — progress is a staff field; the member ends a goal by removing it.
  it('never sends a status, on either payload', () => {
    const values = { ...emptyGoalForm, personal_goal_id: '4', target_value: '3', target_unit: 'kg' };
    expect(toGoalCreatePayload(values)).not.toHaveProperty('status');
    expect(toGoalUpdatePayload(values)).not.toHaveProperty('status');
    expect(pageSrc).not.toMatch(/status:\s*'(achieved|abandoned|in_progress)'/);
  });

  it('calls only its own /me routes', () => {
    const calls = pageSrc.match(/apiFetch[^(]*\(\s*[`'"]([^`'"]+)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain('/me/personal-goals');
  });

  it('confirms a removal before performing it (§11)', () => {
    expect(pageSrc).toContain("kind: 'remove'");
    expect(pageSrc).toContain('goals.remove_confirm');
  });
});

describe('the section is reachable and gated (§1, Q2)', () => {
  it('is a dashboard tile behind its own member_web flag', () => {
    expect(homeSrc).toContain("featureEnabled('member_web.my_goals')");
    expect(homeSrc).toContain('slot="personal_goals"');
    expect(homeSrc).toContain("nav.goals");
  });

  it('redirects a member whose gym has the section switched off', () => {
    expect(pageSrc).toContain("isFeatureEnabled(featureFlags, 'member_web.my_goals')");
    expect(pageSrc).toContain('router.replace');
  });
});

describe('every string is translated in all three languages (§2)', () => {
  const messages = Object.fromEntries(
    LOCALE_CODES.map((code) => [code, JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'))]),
  ) as Record<string, any>;

  it('declares the goals namespace and the nav label in en/es/ca', () => {
    for (const code of LOCALE_CODES) {
      expect(messages[code].goals, code).toBeTruthy();
      expect(messages[code].nav.goals, code).toBeTruthy();
    }
  });

  it('has the same keys in every language', () => {
    const en = Object.keys(messages.en.goals).sort();
    for (const code of LOCALE_CODES) {
      expect(Object.keys(messages[code].goals).sort(), code).toEqual(en);
    }
  });

  it('labels all seven System goals in every language', () => {
    for (const code of LOCALE_CODES) {
      for (const slug of SYSTEM_PERSONAL_GOAL_SLUGS) {
        expect(messages[code].goals[`goal_${slug}`], `${code}/${slug}`).toBeTruthy();
      }
    }
  });

  it('declares every key the page and the lib resolve', () => {
    const used = new Set<string>();
    for (const src of [pageSrc, libSrc]) {
      for (const match of src.matchAll(/'goals\.([a-z0-9_]+)'/g)) used.add(match[1]);
      for (const match of src.matchAll(/t\(`goals\.([a-z0-9_]+)/g)) used.add(match[1]);
    }
    expect(used.size).toBeGreaterThan(10);
    for (const code of LOCALE_CODES) {
      for (const key of used) {
        if (key.startsWith('goal_')) continue; // resolved from a slug, asserted above
        expect(messages[code].goals[key], `${code}/${key}`).toBeTruthy();
      }
    }
  });

  it('interpolates the goal name into the removal confirmation', () => {
    for (const code of LOCALE_CODES) {
      expect(messages[code].goals.remove_confirm, code).toContain('{name}');
    }
  });
});
