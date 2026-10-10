import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ACTIVE_PLAN_EXISTS,
  activePlanConflict,
  conflictWording,
  formatConflictDate,
  isSharedPlan,
  type ConflictingAssignment,
} from '@/lib/activePlanConflict';

// #956 stage 2 — the replacement confirmation dialog.
//
// Stage 1 made the backend the enforcement point: every assignment path answers
// `409 active_plan_exists` with both plan names and the current plan's dates,
// and only a resend carrying `confirm: true` cancels anything. This stage is the
// UX half, and the two properties worth pinning down are (a) the first attempt
// never confirms, so a plan cannot be cancelled without the warning being shown,
// and (b) all four entry points render the *same* dialog, because the rule is one
// rule.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// pure module is asserted directly and the page wiring is pinned by scanning the
// sources, exactly as assign-plan-inline.test.ts (#628) does.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (...parts: string[]) => stripComments(readFileSync(join(SRC, ...parts), 'utf-8'));

const dialogSrc = read('components', 'ReplacePlanDialog.tsx');
const confirmDialogSrc = read('components', 'ConfirmDialog.tsx');

/**
 * The admin entry points that replace a Membership Plan through the assignment
 * flow. The Member card's "+ Add Membership Plan" left this list in #1325 PR 3b:
 * it creates a ProductSet version, which never overwrites, so the server has no
 * confirmable replacement to ask about (see `member-membership-sections.test.ts`).
 */
const ENTRY_POINTS: Array<{ name: string; src: string; confirmSpelling: string }> = [
  {
    name: 'the Member card\'s Assign New Plan',
    src: read('app', '[locale]', 'members', 'AssignPlanInlineEditor.tsx'),
    confirmSpelling: '...(confirmReplacement ? { confirm: true } : {})',
  },
  {
    name: 'the Memberships page\'s create modal',
    src: read('app', '[locale]', 'memberships', 'page.tsx'),
    confirmSpelling: 'if (confirmReplacement) body.confirm = true;',
  },
  {
    name: 'the Plans page\'s Assign modal',
    src: read('app', '[locale]', 'plans', 'AssignPlanModal.tsx'),
    confirmSpelling: '...(confirmReplacement ? { confirm: true } : {})',
  },
];

function assignment(over: Partial<ConflictingAssignment> = {}): ConflictingAssignment {
  return {
    id: 11,
    owner_member_id: 7,
    owner_member_name: 'Ana Ruiz',
    blocked_member_id: 7,
    blocked_member_name: 'Ana Ruiz',
    membership_plan_id: 3,
    membership_plan_name: 'Premium Membership',
    status: 'active',
    starts_at: '2026-01-01',
    ends_at: null,
    ...over,
  };
}

function conflictError(body: unknown, status = 409) {
  return Object.assign(new Error('active_plan_exists'), { status, body });
}

describe('activePlanConflict: reading stage 1\'s 409 (#956)', () => {
  it('mirrors the API\'s error code rather than inventing one', () => {
    expect(ACTIVE_PLAN_EXISTS).toBe('active_plan_exists');
  });

  it('recognises the conflict body and keeps the server\'s sentence', () => {
    const current = assignment();
    const parsed = activePlanConflict(conflictError({
      error: ACTIVE_PLAN_EXISTS,
      message: 'This member already has an active Membership Plan.',
      current_plan: current,
      conflicts: [current],
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.current.id).toBe(11);
    expect(parsed!.conflicts).toHaveLength(1);
    expect(parsed!.message).toContain('already has an active');
  });

  it('always lists the current plan, even if the body omitted it from conflicts', () => {
    // A dialog that listed nothing would ask the admin to confirm cancelling
    // something it cannot name.
    const parsed = activePlanConflict(conflictError({
      error: ACTIVE_PLAN_EXISTS,
      message: 'x',
      current_plan: assignment(),
      conflicts: [],
    }));
    expect(parsed!.conflicts.map((c) => c.id)).toEqual([11]);
  });

  it('ignores every other failure, including the other 409s', () => {
    // A 409 is also how `/close` reports unused value (#511) and how a
    // duplicate key is reported — a replacement dialog for either would be
    // confirming the wrong thing.
    expect(activePlanConflict(conflictError({ error: 'unused_value_impacted', warnings: ['x'] }))).toBeNull();
    expect(activePlanConflict(conflictError({ error: 'This Member is already covered by this Membership.' }))).toBeNull();
    expect(activePlanConflict(conflictError({ error: ACTIVE_PLAN_EXISTS, message: 'x' }, 400))).toBeNull();
    // 409 with the right code but no assignment to name.
    expect(activePlanConflict(conflictError({ error: ACTIVE_PLAN_EXISTS, message: 'x' }))).toBeNull();
    expect(activePlanConflict(new Error('Failed to fetch'))).toBeNull();
    expect(activePlanConflict(undefined)).toBeNull();
  });
});

describe('What the dialog says about a conflict (#956 Q4, UI considerations)', () => {
  it('calls a plan shared only when its owner is somebody else', () => {
    expect(isSharedPlan(assignment())).toBe(false);
    expect(isSharedPlan(assignment({ owner_member_id: 7, blocked_member_id: 9 }))).toBe(true);
  });

  it('picks the plural wording from the number of plans being cancelled', () => {
    const one = assignment();
    const two = assignment({ id: 12 });
    expect(conflictWording({ current: one, conflicts: [one], message: '' })).toEqual({
      titleKey: 'replace_plan_title', bodyKey: 'replace_plan_body', count: 1,
    });
    expect(conflictWording({ current: one, conflicts: [one, two], message: '' })).toEqual({
      titleKey: 'replace_plan_title_many', bodyKey: 'replace_plan_body_many', count: 2,
    });
  });

  it('formats a date without going through Date', () => {
    // A bare YYYY-MM-DD parsed as UTC midnight and formatted locally shows the
    // previous day west of Greenwich.
    expect(formatConflictDate('2026-01-01')).toBe('01/01/2026');
    expect(formatConflictDate('2026-10-01T00:00:00.000Z')).toBe('01/10/2026');
    expect(formatConflictDate(null)).toBe('—');
    expect(dialogSrc).not.toContain('new Date');
  });
});

describe('The dialog is the app\'s existing confirmation (#956 UI considerations)', () => {
  it('renders through ConfirmDialog rather than a second overlay and modal', () => {
    expect(dialogSrc).toContain('<ConfirmDialog');
    expect(dialogSrc).not.toContain('overlayStyle');
    expect(dialogSrc).not.toContain('modalStyle');
  });

  it('introduces no visual system of its own', () => {
    // #929: the chrome is formChrome.ts's. A hex here would be a second one.
    expect(dialogSrc).toMatch(/from '\.\/formChrome'/);
    expect(dialogSrc.match(/#[0-9a-fA-F]{6}/g) ?? []).toEqual([]);
  });

  it('gives ConfirmDialog an optional details slot, so existing callers are unchanged', () => {
    expect(confirmDialogSrc).toContain('details?: React.ReactNode;');
    expect(confirmDialogSrc).toContain('{details && ');
  });

  it('names no endpoint and decides no permission (#806)', () => {
    expect(dialogSrc).not.toContain('apiFetch');
    expect(dialogSrc).not.toContain('/user-memberships');
    expect(dialogSrc).not.toContain('canWrite');
  });

  it('renders nothing at all without a conflict', () => {
    expect(dialogSrc).toContain('if (!conflict) return null;');
  });
});

describe('Every assignment path that can replace a plan confirms through the one dialog (#956 All assignment paths)', () => {
  for (const entry of ENTRY_POINTS) {
    it(`${entry.name} raises it from the 409 and resends with confirm: true`, () => {
      expect(entry.src).toContain('activePlanConflict');
      expect(entry.src).toContain('<ReplacePlanDialog');
      expect(entry.src).toContain(entry.confirmSpelling);
      // The dialog's Continue is the only thing that confirms.
      expect(entry.src).toMatch(/onConfirm=\{\(\) => \w+\(true\)\}/);
    });

    it(`${entry.name} never confirms on the first attempt`, () => {
      // `confirmReplacement ? null : activePlanConflict(err)` is what keeps a
      // confirmed call that fails for another reason from re-opening the dialog
      // in a loop instead of reporting the error.
      expect(entry.src).toContain('confirmReplacement ? null : activePlanConflict(err)');
      // A click handler passed by reference would hand the submit function a
      // MouseEvent as its `confirmReplacement` argument — truthy, so the very
      // first click would cancel the member's plan with no warning shown.
      expect(entry.src).not.toMatch(/on(Click|Save)=\{(handleSubmit|handleSave|save)\}/);
    });

    it(`${entry.name} leaves the draft untouched when the admin cancels`, () => {
      // Cancel clears the conflict and nothing else: no close, no reload, and
      // no request — so the existing plan and its dates are unchanged.
      expect(entry.src).toMatch(/onCancel=\{\(\) => setConflict\(null\)\}/);
    });
  }
});

describe('The dialog\'s copy is one shared set of keys (#806)', () => {
  const KEYS = [
    'replace_plan_title',
    'replace_plan_title_many',
    'replace_plan_body',
    'replace_plan_body_many',
    'replace_plan_current',
    'replace_plan_current_many',
    'replace_plan_new',
    'replace_plan_since',
    'replace_plan_shared',
    'replace_plan_dates',
    'replace_plan_dates_many',
    'replace_plan_confirm',
    'replace_plan_cancel',
  ];

  for (const code of LOCALE_CODES) {
    it(`${code} carries every key under common`, () => {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of KEYS) {
        expect(typeof messages.common[key], `${code}: common.${key}`).toBe('string');
        expect(messages.common[key].length).toBeGreaterThan(0);
      }
      // next-intl prints a missing placeholder's key verbatim, so the plural
      // sentences have to interpolate the count they are chosen for.
      for (const key of ['replace_plan_title_many', 'replace_plan_body_many']) {
        expect(messages.common[key]).toContain('{count}');
      }
      expect(messages.common.replace_plan_since).toContain('{date}');
      expect(messages.common.replace_plan_shared).toContain('{owner}');
    });
  }

  it('is resolved in the shared `common` namespace, not per page', () => {
    expect(dialogSrc).toContain("useTranslations('common')");
    for (const entry of ENTRY_POINTS) {
      expect(entry.src).not.toContain('replace_plan_');
    }
  });
});
