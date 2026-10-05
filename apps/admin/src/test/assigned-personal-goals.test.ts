import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ASSIGNED_GOAL_STATUSES,
  ASSIGNED_PERSONAL_GOALS_ROOT,
  ASSIGNED_PERSONAL_GOAL_AUDIT_ENTITY,
  assignedPersonalGoalFormError,
  emptyAssignedPersonalGoalForm,
  formatGoalPeriod,
  formatTarget,
  toAssignedPersonalGoalCreatePayload,
  toAssignedPersonalGoalFormValues,
  toAssignedPersonalGoalUpdatePayload,
  type AssignedPersonalGoalRow,
} from '@/components/personalGoals/assignedPersonalGoalProfile';
import { navigationGroups } from '@/config/navigationGroups';

// #948 §4 — Assigned Personal Goals.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so this
// pins down the pure declaration directly and the wiring by scanning the sources
// and the locale files, the way add-product-edit-mode.test.ts (#957) and
// theme-primary-buttons.test.ts (#954) do.
//
// What it asserts is what the ticket decided, not how the files are written:
//   - the status vocabulary mirrors the API's, so the selector cannot offer a
//     value `chk_mpgoal_status` would refuse;
//   - the `PUT` payload never carries the member or the goal — an assignment is
//     what gets edited, never who it is for (#974's rule for a frozen column);
//   - the Member card's controls are gated on **Edit mode**, absent rather than
//     disabled in the read-only half (#797/#957);
//   - one form body serves both screens (#806) and neither restates chrome.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const COMPONENT_DIR = join(SRC, 'components', 'personalGoals');
const PAGE = join(SRC, 'app', '[locale]', 'assigned-personal-goals', 'page.tsx');
const MEMBER_ROW = join(SRC, 'app', '[locale]', 'members', 'MemberExpandedRow.tsx');
const API_DOMAIN = join(SRC, '..', '..', '..', 'api', 'src', 'domain', 'personalGoalAssignment.ts');
const API_MIGRATION = join(SRC, '..', '..', '..', 'api', 'src', 'infra', 'migrations', '212_member_personal_goals.js');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

/** The comments explain what each rule is for, so every scan runs on code only. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const formSrc = read(join(COMPONENT_DIR, 'AssignedPersonalGoalForm.tsx'));
const sectionSrc = read(join(COMPONENT_DIR, 'AssignedPersonalGoalsSection.tsx'));
const memberSectionSrc = read(join(COMPONENT_DIR, 'MemberPersonalGoals.tsx'));
const pageSrc = read(PAGE);
const memberRowSrc = read(MEMBER_ROW);

const messages = Object.fromEntries(
  LOCALE_CODES.map((code) => [code, JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'))]),
);

function row(overrides: Partial<AssignedPersonalGoalRow> = {}): AssignedPersonalGoalRow {
  return {
    id: 1,
    gym_id: 'g1',
    member_id: 7,
    personal_goal_id: 3,
    target_value: null,
    target_unit: null,
    start_date: null,
    target_date: null,
    status: 'in_progress',
    notes: null,
    created_at: '2026-01-01T10:00:00.000Z',
    modified_at: null,
    created_by_name: 'Staff',
    modified_by_name: null,
    member_name: 'Ada',
    goal_name: 'Weight Loss',
    goal_slug: 'weight_loss',
    goal_gym_id: null,
    ...overrides,
  };
}

describe('the status vocabulary mirrors the API', () => {
  it('lists the same three values the domain module and the CHECK do', () => {
    expect(ASSIGNED_GOAL_STATUSES).toEqual(['in_progress', 'achieved', 'abandoned']);

    const domain = readFileSync(API_DOMAIN, 'utf-8');
    const declared = domain.match(/PERSONAL_GOAL_ASSIGNMENT_STATUSES = \[([^\]]+)\]/);
    expect(declared).not.toBeNull();
    const apiValues = [...declared![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(apiValues).toEqual([...ASSIGNED_GOAL_STATUSES]);

    // The migration's own mirror, which is what `chk_mpgoal_status` is built from.
    const migration = readFileSync(API_MIGRATION, 'utf-8');
    const seeded = migration.match(/const STATUSES = \[([^\]]+)\]/);
    expect(seeded).not.toBeNull();
    expect([...seeded![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...ASSIGNED_GOAL_STATUSES]);
  });

  it('never offers "deleted" as a progress value', () => {
    expect(ASSIGNED_GOAL_STATUSES).not.toContain('deleted');
  });
});

describe('the form values and the payloads', () => {
  it('starts in_progress, with the member pre-filled when the surface knows it', () => {
    expect(emptyAssignedPersonalGoalForm().status).toBe('in_progress');
    expect(emptyAssignedPersonalGoalForm().member_id).toBe('');
    expect(emptyAssignedPersonalGoalForm(7).member_id).toBe('7');
  });

  it('seeds the Edit form from the persisted row, dates included', () => {
    const form = toAssignedPersonalGoalFormValues(row({
      target_value: 5, target_unit: 'kg',
      start_date: '2026-01-01T00:00:00.000Z', target_date: '2026-06-30',
      status: 'achieved', notes: 'n',
    }));
    expect(form).toMatchObject({
      member_id: '7', personal_goal_id: '3', target_value: '5', target_unit: 'kg',
      start_date: '2026-01-01', target_date: '2026-06-30', status: 'achieved', notes: 'n',
    });
  });

  it('sends every empty optional field as an explicit null', () => {
    const payload = toAssignedPersonalGoalCreatePayload(emptyAssignedPersonalGoalForm(7));
    expect(payload).toMatchObject({
      member_id: 7, target_value: null, target_unit: null,
      start_date: null, target_date: null, notes: null, status: 'in_progress',
    });
  });

  it('never carries the member or the goal on an update', () => {
    const payload = toAssignedPersonalGoalUpdatePayload(
      toAssignedPersonalGoalFormValues(row({ target_value: 5, target_unit: 'kg' })),
    );
    expect(payload).not.toHaveProperty('member_id');
    expect(payload).not.toHaveProperty('personal_goal_id');
    expect(payload).toMatchObject({ target_value: 5, target_unit: 'kg' });
  });
});

describe('the client-side validation answers locale keys', () => {
  const base = emptyAssignedPersonalGoalForm(7);

  it('requires the member and the goal', () => {
    expect(assignedPersonalGoalFormError({ ...base, member_id: '' })).toBe('error_member_required');
    expect(assignedPersonalGoalFormError(base)).toBe('error_goal_required');
  });

  it('mirrors the two cross-field rules the API enforces', () => {
    const filled = { ...base, personal_goal_id: '3' };
    expect(assignedPersonalGoalFormError(filled)).toBeNull();
    expect(assignedPersonalGoalFormError({ ...filled, target_value: '-1' })).toBe('error_target_value');
    expect(assignedPersonalGoalFormError({ ...filled, target_unit: 'kg' })).toBe('error_unit_needs_value');
    expect(assignedPersonalGoalFormError({
      ...filled, start_date: '2026-06-01', target_date: '2026-01-01',
    })).toBe('error_target_date_order');
    expect(assignedPersonalGoalFormError({
      ...filled, start_date: '2026-01-01', target_date: '2026-01-01',
    })).toBeNull();
  });

  it('has a key for every error in all three locales', () => {
    const keys = [
      'error_member_required', 'error_goal_required', 'error_target_value',
      'error_unit_needs_value', 'error_target_date_order', 'error_generic',
    ];
    for (const code of LOCALE_CODES) {
      for (const key of keys) {
        expect(messages[code].assigned_personal_goals?.[key], `${code}.${key}`).toBeTruthy();
      }
    }
  });
});

describe('the formatters', () => {
  it('reads a target as one phrase and trims a DECIMAL trailing zero', () => {
    expect(formatTarget(row())).toBe('—');
    expect(formatTarget(row({ target_value: 5 }))).toBe('5');
    expect(formatTarget(row({ target_value: 5, target_unit: 'kg' }))).toBe('5 kg');
    expect(formatTarget(row({ target_value: 5.0, target_unit: 'kg' }))).toBe('5 kg');
    expect(formatTarget(row({ target_value: 5.5, target_unit: 'kg' }))).toBe('5.5 kg');
  });

  it('reads a period as one phrase, with an em dash for a missing end', () => {
    expect(formatGoalPeriod(row(), 'en')).toBe('—');
    expect(formatGoalPeriod(row({ start_date: '2026-01-01' }), 'en')).toContain('→ —');
    const both = formatGoalPeriod(row({ start_date: '2026-01-01', target_date: '2026-06-30' }), 'en');
    expect(both).toContain('2026');
    expect(both).toContain('→');
  });
});

describe('the navigation entry', () => {
  it('sits in the Nutrition & Goals group, outside /nutrition/, on the Personal Goals flag', () => {
    const group = navigationGroups.find((g) => g.id === 'nutrition');
    const item = group?.items.find((i) => i.labelKey === 'nav.assigned_personal_goals');
    expect(item).toBeDefined();
    expect(item!.href).toBe('/{{locale}}/assigned-personal-goals');
    expect(item!.href).not.toContain('/nutrition/');
    expect(item!.featureKey).toBe('nutrition.personal_goals');
  });

  it('is labelled in all three locales, and so is the Member card section', () => {
    for (const code of LOCALE_CODES) {
      expect(messages[code].nav?.assigned_personal_goals, code).toBeTruthy();
      expect(messages[code].members?.section_personal_goals, code).toBeTruthy();
      expect(messages[code].assigned_personal_goals?.title, code).toBeTruthy();
    }
  });
});

describe('one editor, two screens (#806)', () => {
  it('is the same form component on the gym-wide section and the Member card', () => {
    expect(sectionSrc).toContain('AssignedPersonalGoalForm');
    expect(memberSectionSrc).toContain('AssignedPersonalGoalForm');
    // Neither screen builds a payload or a path of its own.
    for (const src of [sectionSrc, memberSectionSrc]) {
      expect(src).toContain('ASSIGNED_PERSONAL_GOALS_ROOT');
      expect(src).not.toMatch(/'\/member-personal-goals/);
    }
  });

  it('renders the member and the goal as values when editing, never as controls', () => {
    const editHalf = formSrc.split("mode === 'create'")[1].split('</>')[1] ?? '';
    expect(editHalf).toContain('formValueStyle');
    // The member picker exists only on the create half, and only when the
    // surface does not already know whose goals these are.
    expect(formSrc).toContain('{members && (');
    expect(memberSectionSrc).not.toContain('members={');
  });

  it('keeps the endpoint and the permission out of the shared form', () => {
    expect(formSrc).not.toContain('apiFetch');
    expect(formSrc).not.toContain('useApiClient');
    expect(formSrc).not.toContain('canWrite');
    expect(formSrc).not.toContain('useTranslations');
  });
});

describe('the Member card section is behind Edit mode (#797/#957)', () => {
  it('gates every control on canWrite && editing', () => {
    expect(memberSectionSrc).toContain('const canEdit = canWrite && editing;');
    // Each control is rendered only inside that gate — never disabled instead.
    expect(memberSectionSrc).toContain('{canEdit && (');
    expect(memberSectionSrc).toContain('{canEdit && !creating && (');
    expect(memberSectionSrc).not.toContain('disabled={!canWrite}');
  });

  it('is handed the card own mode, and Personal Goals write access', () => {
    // #1070: the flag is `nutrition.personal_goals`' own, not the NUTRITION
    // module's — the Personal Trainer override reaches this section too.
    expect(memberRowSrc).toContain('<MemberPersonalGoals memberId={memberId} canWrite={canManagePersonalGoals} editing={editing} />');
    expect(memberRowSrc).toContain("t('members.section_personal_goals')");
  });

  it('uses the card existing add affordance rather than a style of its own', () => {
    expect(memberSectionSrc).toContain('dashedAddBtnStyle');
    expect(memberSectionSrc).toContain('CardDetailRow');
    expect(memberSectionSrc).not.toMatch(/#6c63ff/);
  });
});

describe('the page is a thin wrapper (#806)', () => {
  it('supplies the permissions and the two namespaces, and restates no control', () => {
    // #1070: with Personal Goals' own feature key, so the Personal Trainer
    // override the API enforces also decides the controls this page offers.
    expect(pageSrc).toContain("useModuleAccess('NUTRITION', 'nutrition.personal_goals')");
    expect(pageSrc).toContain("useTranslations('assigned_personal_goals')");
    // A System goal label was written in `goal_library`, so that is where the
    // page resolves it (#947) — the section never picks a namespace.
    expect(pageSrc).toContain("useTranslations('goal_library')");
    expect(pageSrc).toContain('<AssignedPersonalGoalsSection');
    expect(pageSrc).not.toContain('DataTable');
    expect(pageSrc).not.toContain('apiFetch');
  });

  it('deep-links the Audit Log by the canonical entity type', () => {
    expect(ASSIGNED_PERSONAL_GOAL_AUDIT_ENTITY).toBe('member_personal_goal');
    expect(ASSIGNED_PERSONAL_GOALS_ROOT).toBe('/member-personal-goals');
    const modalSrc = read(join(COMPONENT_DIR, 'AssignedPersonalGoalDetailsModal.tsx'));
    expect(modalSrc).toContain('ViewAuditLogButton');
    expect(modalSrc).toContain('ASSIGNED_PERSONAL_GOAL_AUDIT_ENTITY');
  });
});

/**
 * #1034 §5/§7 — the catalogue's target reaches the form that assigns it, and the
 * dialog launched from the goal itself is a narrower view of this same create
 * form rather than a second one.
 */
describe('the Gym Goal\'s target reaches both assignment surfaces (#1034)', () => {
  const formSrc = read(join(COMPONENT_DIR, 'AssignedPersonalGoalForm.tsx'));
  const modalSrc = read(join(COMPONENT_DIR, 'AssignGoalToMemberModal.tsx'));

  it('pre-fills the pair when a goal is picked, and clears it when the goal is', () => {
    // The inheritance itself is the server's (§7); this keeps the form showing
    // the values that will actually be stored.
    expect(formSrc).toContain('onChange={(e) => set(selectGoal(e.target.value, goals))}');
    expect(formSrc).toContain('function selectGoal(');
    expect(formSrc).toContain("target_unit: goal?.target_unit ?? ''");
  });

  it('is one create form, not two', () => {
    expect(modalSrc).toContain('toAssignedPersonalGoalCreatePayload');
    expect(modalSrc).toContain('assignedPersonalGoalFormError');
    expect(modalSrc).toContain('emptyAssignedPersonalGoalForm');
    // No second payload shape and no second validation rule.
    expect(modalSrc).not.toContain('JSON.stringify({ member_id');
  });

  it('wears the app\'s own modal and form chrome, declaring no style of its own', () => {
    expect(modalSrc).toContain('CrudModal');
    expect(modalSrc).toContain("from '@/components/formChrome'");
    expect(modalSrc).not.toMatch(/#6c63ff/);
    expect(modalSrc).not.toMatch(/background: '#/);
  });

  it('both pickers offer the pair, so neither screen reads the catalogue a second way', () => {
    for (const file of ['AssignedPersonalGoalsSection.tsx', 'MemberPersonalGoals.tsx']) {
      const src = read(join(COMPONENT_DIR, file));
      expect(src, file).toContain('target_value: g.target_value ?? null');
      expect(src, file).toContain('target_unit: g.target_unit ?? null');
    }
  });

  it('formats an assignment target the same way whatever it came from', () => {
    expect(formatTarget({ target_value: 3, target_unit: 'kg' })).toBe('3 kg');
    expect(formatTarget({ target_value: 0, target_unit: 'kg' })).toBe('0 kg');
    expect(formatTarget({ target_value: null, target_unit: null })).toBe('—');
  });
});
