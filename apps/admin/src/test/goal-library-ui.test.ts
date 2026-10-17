import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  GOAL_API_ROOTS,
  GOAL_AUDIT_ENTITIES,
  GOAL_KINDS,
  GYM_CONFIGURABLE_GOAL_KINDS,
  TRANSLATED_GOAL_KINDS,
  WEBP_IMAGE_GOAL_KINDS,
  goalKindIsTranslated,
  goalListName,
  toTranslationsPayload,
  LIBRARY_TABS,
  MEASURABLE_GOAL_KINDS,
  SYSTEM_GOAL_SLUGS,
  emptyGoalForm,
  formatGoalTarget,
  goalAvailability,
  goalDisplayName,
  goalFormError,
  isGoalTab,
  isMeasurableGoalKind,
  isSystemGoal,
  toGoalFormValues,
  toGoalPayload,
  truncateDescription,
  type GoalRow,
} from '@/components/goalLibrary/goalProfile';
// The declarations this page mirrors are the API's — imported directly, the way
// permission-matrix-parity.test.ts does, so the two cannot drift silently.
import {
  GOAL_LIBRARY_AUDIT_ENTITIES,
  GOAL_LIBRARY_KINDS,
  GYM_CONFIGURABLE_GOAL_KINDS as API_GYM_CONFIGURABLE_GOAL_KINDS,
  TRANSLATED_GOAL_KINDS as API_TRANSLATED_GOAL_KINDS,
  WEBP_IMAGE_GOAL_KINDS as API_WEBP_IMAGE_GOAL_KINDS,
  MEASURABLE_GOAL_KINDS as API_MEASURABLE_GOAL_KINDS,
  SYSTEM_GOALS,
  SYSTEM_PERSONAL_GOAL_TARGETS,
} from '../../../../api/src/domain/goalLibrary';

// #947 — the Nutrition Library is three tabs (Foods, Personal Goals, Nutrition
// Goals) in *both* libraries, the two goal catalogues are separate lists with
// their own search / list / add / actions, and System and Gym rows are visually
// distinguishable.
//
// apps/admin has no component-test infra (docs/architecture.md TL;DR), so the
// structural half is pinned by scanning source the way exercises-inline-create
// does; the declarations and the label helper are pure and exercised directly.

const ADMIN_SRC = join(__dirname, '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (...parts: string[]) => stripComments(readFileSync(join(ADMIN_SRC, ...parts), 'utf-8'));

const sectionSrc = read('components', 'goalLibrary', 'GoalLibrarySection.tsx');
const tabsSrc = read('components', 'goalLibrary', 'LibraryTabs.tsx');
// #961 — the tab strip the two libraries and the Member card share.
const sharedTabsSrc = read('components', 'Tabs.tsx');
const modalSrc = read('components', 'goalLibrary', 'GoalDetailsModal.tsx');
const gymPageSrc = read('app', '[locale]', 'nutrition', 'nutrition-library', 'page.tsx');
const cordelPageSrc = read('app', '[locale]', 'cordel', 'nutrition-library', 'page.tsx');
// #948 — the two Personal Goals sections, which render the same shared component.
const personalPageSrc = read('app', '[locale]', 'personal-goals', 'page.tsx');
const cordelPersonalPageSrc = read('app', '[locale]', 'cordel', 'personal-goals', 'page.tsx');
const navSrc = read('config', 'navigationGroups.ts');
const apiAppSrc = readFileSync(join(__dirname, '..', '..', '..', '..', 'api', 'src', 'app.ts'), 'utf-8');

function goalNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.goal_library ?? {}) as Record<string, string>;
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, goalNamespace(c)]));

/** The source between two markers. */
function slice(from: string, to: string, src: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `marker not found after ${from}: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('library tabs (§1, §2, §6)', () => {
  // #948 §3/§9 moved Personal Goals out of the strip into its own section, so what
  // is left is Foods and the goal catalogue that *is* a nutrition concept.
  it('declares exactly two tabs, Foods first', () => {
    expect(LIBRARY_TABS.map((t) => t.id)).toEqual(['foods', 'nutrition']);
  });

  it('separates the goal tab from Foods', () => {
    expect(isGoalTab('foods')).toBe(false);
    expect(isGoalTab('nutrition')).toBe(true);
    // A tab id is still either 'foods' or a goal kind, so no tab can name a
    // catalogue that does not exist — the kinds themselves are unchanged, since
    // the Personal Goals sections render the very same component.
    const goalTabs = LIBRARY_TABS.filter((t) => isGoalTab(t.id)).map((t) => t.id as string);
    expect(goalTabs).toEqual(['nutrition']);
    for (const id of goalTabs) expect(GOAL_KINDS as readonly string[]).toContain(id);
  });

  it('no longer offers a Personal Goals tab on either library page', () => {
    for (const src of [gymPageSrc, cordelPageSrc]) {
      expect(src).not.toContain('tab_personal_goals');
      expect(src).not.toContain("kind=\"personal\"");
    }
    expect(Object.keys(locales.en)).not.toContain('tab_personal_goals');
  });

  it('is one component, rendered by both libraries', () => {
    for (const [name, src] of [['gym', gymPageSrc], ['cordel', cordelPageSrc]] as const) {
      expect(src, `${name} page does not render LibraryTabs`).toContain('<LibraryTabs');
      expect(src).toContain("from '@/components/goalLibrary/LibraryTabs'");
      expect(src).toContain('<GoalLibrarySection');
    }
  });

  it('renders the tab strip from the declaration, never a hardcoded list', () => {
    // #961 — the strip itself moved to the app's shared `Tabs`, so this module
    // binds that component to LIBRARY_TABS and still spells no label.
    expect(tabsSrc).toContain('tabs={LIBRARY_TABS}');
    expect(tabsSrc).toContain("from '@/components/Tabs'");
    for (const tab of LIBRARY_TABS) {
      expect(tabsSrc).not.toContain(`'${tab.labelKey}'`);
    }
  });

  it('marks the selected tab for assistive technology', () => {
    expect(sharedTabsSrc).toContain('role="tablist"');
    expect(sharedTabsSrc).toContain('role="tab"');
    expect(sharedTabsSrc).toContain('aria-selected={selected}');
  });

  it('shows the goal tab\'s section with each library\'s own scope', () => {
    expect(gymPageSrc).toMatch(/isGoalTab\(tab\)[\s\S]*kind=\{tab\}[\s\S]*scope="gym"/);
    expect(cordelPageSrc).toMatch(/isGoalTab\(tab\)[\s\S]*kind=\{tab\}[\s\S]*scope="platform"/);
  });

  it('hides the Foods `+ Add` while a goals tab is open (§7)', () => {
    // Each goals tab renders its own add button, so the Foods one is absent
    // rather than relabelled.
    for (const src of [gymPageSrc, cordelPageSrc]) {
      expect(src).toMatch(/\{tab === 'foods' && \(\s*<button/);
    }
  });
});

describe('endpoints and audit types', () => {
  it('names the four routes app.ts mounts', () => {
    expect(GOAL_API_ROOTS).toEqual({
      gym: { personal: '/personal-goals', nutrition: '/nutrition-goals' },
      platform: { personal: '/platform/personal-goals', nutrition: '/platform/nutrition-goals' },
    });
    for (const roots of Object.values(GOAL_API_ROOTS)) {
      for (const root of Object.values(roots)) {
        expect(apiAppSrc, `${root} is not mounted`).toContain(`app.use('${root}'`);
      }
    }
  });

  it('keeps the endpoint out of the shared section — the page supplies it (#806)', () => {
    expect(sectionSrc).toContain('GOAL_API_ROOTS[scope][kind]');
    // No literal route anywhere in the component, so one of the four screens
    // cannot be pointed at another's router by a copy-paste.
    expect(sectionSrc).not.toContain("'/personal-goals'");
    expect(sectionSrc).not.toContain("'/platform/personal-goals'");
  });

  it('mirrors the API\'s audit entity types', () => {
    expect([...GOAL_KINDS]).toEqual([...GOAL_LIBRARY_KINDS]);
    expect(GOAL_AUDIT_ENTITIES).toEqual(GOAL_LIBRARY_AUDIT_ENTITIES);
  });

  it('deep-links the Audit Log through the shared button, by canonical type (#675)', () => {
    expect(modalSrc).toContain('<ViewAuditLogButton');
    expect(modalSrc).toContain('GOAL_AUDIT_ENTITIES[kind]');
  });
});

describe('System goal labels', () => {
  it('mirrors the slugs migration 206 seeds', () => {
    for (const kind of GOAL_KINDS) {
      expect([...SYSTEM_GOAL_SLUGS[kind]]).toEqual(SYSTEM_GOALS[kind].map((g) => g.slug));
    }
  });

  it('translates a seeded System goal and falls back to the stored name otherwise', () => {
    const translate = (key: string) => `T:${key}`;
    expect(goalDisplayName({ slug: 'muscle_gain', name: 'Muscle Gain' }, 'personal', translate))
      .toBe('T:personal_goal_muscle_gain');
    expect(goalDisplayName({ slug: 'fasting', name: 'Fasting' }, 'nutrition', translate))
      .toBe('T:nutrition_goal_fasting');
    // A gym's own goal, and a System goal Cordel adds later, carry no slug.
    expect(goalDisplayName({ slug: null, name: 'Competition Preparation' }, 'personal', translate))
      .toBe('Competition Preparation');
    // next-intl prints a missing key verbatim, so an unknown slug must never
    // reach t() — the fallback is decided first (CLAUDE.md).
    expect(goalDisplayName({ slug: 'surprise', name: 'Surprise' }, 'personal', translate))
      .toBe('Surprise');
  });

  it('does not read a Personal slug as a Nutrition one', () => {
    const translate = (key: string) => `T:${key}`;
    // The two catalogues are separate concepts: a slug is only known to its own.
    expect(goalDisplayName({ slug: 'protein', name: 'Protein' }, 'personal', translate)).toBe('Protein');
    expect(goalDisplayName({ slug: 'energy', name: 'Energy' }, 'nutrition', translate)).toBe('Energy');
  });

  it('has a locale key for every seeded slug, in every language', () => {
    for (const [code, ns] of Object.entries(locales)) {
      for (const kind of GOAL_KINDS) {
        for (const slug of SYSTEM_GOAL_SLUGS[kind]) {
          const key = `${kind}_goal_${slug}`;
          expect(ns[key], `${code}.json goal_library.${key} is missing`).toBeTruthy();
        }
      }
    }
  });
});

describe('row shape and payloads', () => {
  const row: GoalRow = {
    id: 7,
    gym_id: 'gym-1',
    slug: null,
    name: 'Competition Preparation',
    description: '  the season  ',
    status: 'active',
    created_at: '2026-10-01 10:00:00',
    created_by: 'Staff',
    modified_at: null,
    modified_by: null,
    deleted_at: null,
    deleted_by: null,
  };

  it('tells a System row from a gym\'s own', () => {
    expect(isSystemGoal(row)).toBe(false);
    expect(isSystemGoal({ ...row, gym_id: null })).toBe(true);
  });

  it('seeds the Edit form from the persisted row', () => {
    expect(toGoalFormValues({ ...row, target_value: 3, target_unit: 'kg' })).toEqual({
      name: 'Competition Preparation', description: '  the season  ',
      target_value: '3', target_unit: 'kg', target_type: 'absolute',
    });
    expect(toGoalFormValues({ ...row, description: null })).toEqual({
      name: 'Competition Preparation', description: '', target_value: '', target_unit: '', target_type: 'absolute',
    });
    expect(emptyGoalForm()).toEqual({ name: '', description: '', target_value: '', target_unit: '', target_type: 'absolute' });
    expect(goalFormError({ ...emptyGoalForm(), name: 'x', target_value: '-5', target_type: 'relative' }, 'personal')).toBeNull();
  });

  it('submits a trimmed description as `` so clearing it persists', () => {
    // The routers read an empty string as "clear it" and an absent key as "leave
    // it alone", so the key is always present.
    expect(toGoalPayload({ ...emptyGoalForm(), name: ' Energy ', description: '   ' }, 'nutrition'))
      .toEqual({ name: 'Energy', description: '' });
    expect(toGoalPayload({ ...emptyGoalForm(), name: 'Energy', description: ' x ' }, 'nutrition'))
      .toEqual({ name: 'Energy', description: 'x' });
  });
});

/**
 * #1034 §1/§2/§13 — the measurable pair, and the one declaration that says which
 * kinds have it.
 */
describe('a Personal Goal is measurable, a Nutrition Goal is not (#1034 §1)', () => {
  it('mirrors the API\'s own declaration of which kinds carry a target', () => {
    // The API is the enforcement point (its routers project the columns off that
    // list); this is the mirror the admin renders from, and the two drifting is
    // how a form comes to offer a field the router ignores.
    expect([...MEASURABLE_GOAL_KINDS]).toEqual([...API_MEASURABLE_GOAL_KINDS]);
    expect(isMeasurableGoalKind('personal')).toBe(true);
    expect(isMeasurableGoalKind('nutrition')).toBe(false);
    // Every seeded default belongs to a measurable kind's own catalogue (§2).
    for (const slug of Object.keys(SYSTEM_PERSONAL_GOAL_TARGETS)) {
      expect(SYSTEM_GOAL_SLUGS.personal).toContain(slug);
    }
  });

  it('submits the pair for a measurable kind only, with an empty value as an explicit clear', () => {
    const form = { ...emptyGoalForm(), name: 'Lose weight', target_value: ' 3 ', target_unit: ' kg ' };
    expect(toGoalPayload(form, 'personal')).toEqual({
      name: 'Lose weight', description: '', target_value: 3, target_unit: 'kg', target_type: 'absolute',
    });
    expect(toGoalPayload({ ...form, target_value: '', target_unit: '' }, 'personal')).toEqual({
      name: 'Lose weight', description: '', target_value: null, target_unit: null, target_type: 'absolute',
    });
    // A Nutrition Goal has no such columns, so the payload must not carry keys
    // the router would ignore (#974).
    expect(toGoalPayload(form, 'nutrition')).toEqual({ name: 'Lose weight', description: '' });
  });

  it('refuses a negative or non-numeric target, and a unit with nothing to qualify', () => {
    const base = { ...emptyGoalForm(), name: 'Lose weight' };
    expect(goalFormError(base, 'personal')).toBeNull();
    expect(goalFormError({ ...base, name: '  ' }, 'personal')).toBe('error_required');
    expect(goalFormError({ ...base, target_value: '-1' }, 'personal')).toBe('error_target_value');
    expect(goalFormError({ ...base, target_value: 'x' }, 'personal')).toBe('error_target_value');
    expect(goalFormError({ ...base, target_unit: 'kg' }, 'personal')).toBe('error_unit_needs_value');
    // A value with no unit is incomplete rather than contradictory, exactly as
    // `chk_pgoal_target_unit` has it — one direction only.
    expect(goalFormError({ ...base, target_value: '3' }, 'personal')).toBeNull();
    // None of it applies to a kind that has no target at all.
    expect(goalFormError({ ...base, target_unit: 'kg' }, 'nutrition')).toBeNull();
  });

  it('formats a target as one phrase, trimming the DECIMAL\'s trailing zeros', () => {
    expect(formatGoalTarget({ target_value: 3, target_unit: 'kg' })).toBe('3 kg');
    expect(formatGoalTarget({ target_value: 3.5, target_unit: null })).toBe('3.5');
    // Maintenance: a change of zero is the goal, not a missing target.
    expect(formatGoalTarget({ target_value: 0, target_unit: 'kg' })).toBe('0 kg');
    expect(formatGoalTarget({ target_value: null, target_unit: null })).toBe('—');
    expect(formatGoalTarget({})).toBe('—');
  });

  it('renders the pair, its column and its read-only value behind that one predicate', () => {
    // Never a branch on the kind in the JSX: the column, the read-only field and
    // both halves of the form ask `measurable`, so they cannot disagree.
    expect(sectionSrc).toContain('const measurable = isMeasurableGoalKind(kind);');
    expect(sectionSrc).toContain("{measurable && (");
    expect(sectionSrc).toContain("...(measurable ? [{");
    expect(sectionSrc).not.toMatch(/kind === 'personal'/);
  });
});

/** #1034 §4 — the `Assign goal to member` action is the page's to offer. */
describe('Assign goal to member (#1034 §4)', () => {
  it('is absent unless the page passes a handler, so Cordel\'s library never offers it', () => {
    const menu = slice('<ContextMenu items={[', '/>', sectionSrc);
    expect(menu).toContain('...(onAssign ? [{');
    expect(menu).toContain("label: label('assign_to_member')");
    // It is not destructive, so it carries no red flag — only Delete does.
    const assignBlock = slice('...(onAssign ? [{', '}] : [])', menu);
    expect(assignBlock).not.toContain('danger');
    // …and it is a write, so it is gated like every other one.
    expect(assignBlock).toContain('disabled: !canWrite');
  });

  it('is wired by the gym page and not by Cordel\'s', () => {
    const gymPage = readFileSync(
      join(__dirname, '../app/[locale]/personal-goals/page.tsx'), 'utf8',
    );
    const basePage = readFileSync(
      join(__dirname, '../app/[locale]/cordel/personal-goals/page.tsx'), 'utf8',
    );
    expect(gymPage).toContain('onAssign=');
    expect(gymPage).toContain('AssignGoalToMemberModal');
    expect(basePage).not.toContain('onAssign');
  });

  it('pre-fills the dialog from the Gym Goal and submits through the one create declaration', () => {
    const modal = readFileSync(
      join(__dirname, '../components/personalGoals/AssignGoalToMemberModal.tsx'), 'utf8',
    );
    // §5: the goal is the row the action was launched from, never a picker.
    expect(modal).not.toContain("set({ personal_goal_id");
    expect(modal).toContain('personal_goal_id: String(goal.id)');
    // §5/§8: the target is pre-filled and editable, the member is required.
    expect(modal).toContain('target_value: goal.target_value');
    expect(modal).toContain("label('choose_member')");
    // One create form, not a second one.
    expect(modal).toContain('toAssignedPersonalGoalCreatePayload');
    expect(modal).toContain('assignedPersonalGoalFormError');
  });
});

describe('read-only expanded row, editing behind the context menu (#797–#800)', () => {
  const readOnly = slice('function renderReadOnly(', 'const columns:', sectionSrc);

  it('holds no control of its own', () => {
    for (const control of ['<input', '<select', '<textarea', '<button', 'onChange']) {
      expect(readOnly, `the read-only view renders ${control}`).not.toContain(control);
    }
  });

  it('opens the form from the ⋮ menu only, and expands the row it edits', () => {
    const menu = slice('<ContextMenu items={[', '/>', sectionSrc);
    expect(menu).toContain("label('edit')");
    expect(menu).toContain("label('delete')");
    expect(menu).toContain("label('details')");
    // Details is last on this page's menu.
    expect(menu.indexOf("label('details')")).toBeGreaterThan(menu.indexOf("label('edit')"));
    // Delete is the only destructive entry, and red comes from the flag.
    expect(menu).toContain('danger: true');
    expect(sectionSrc).toContain('new Set(prev).add(goal.id)');
  });

  it('gates every write on the page\'s own permission', () => {
    const menu = slice('<ContextMenu items={[', '/>', sectionSrc);
    // Edit, Delete, Assign goal to member (#1034 §4) and — since #1181 —
    // Duplicate and Activate / Deactivate (one item, two spellings). Details
    // is a read and is deliberately not among them.
    expect(menu.match(/disabled: !canWrite/g)?.length).toBe(6);
    // The section decides no permission of its own (#806).
    expect(sectionSrc).not.toContain('useModuleAccess');
  });

  it('keeps a System row read-only in a gym\'s library (§5)', () => {
    expect(sectionSrc).toContain("scope === 'platform' || !isSystemGoal(goal)");
  });

  /** #1181 — Duplicate, per-gym Activate / Deactivate and the standard header. */
  describe('Duplicate and per-gym availability (#1181)', () => {
    const menu = slice('<ContextMenu items={[', '/>', sectionSrc);

    it('mirrors the API\'s declaration of which kinds a gym configures', () => {
      expect([...GYM_CONFIGURABLE_GOAL_KINDS]).toEqual([...API_GYM_CONFIGURABLE_GOAL_KINDS]);
      expect(GYM_CONFIGURABLE_GOAL_KINDS).toEqual(['personal']);
      // Asked once, and only in a gym's own library — the platform list has no gym.
      expect(sectionSrc).toContain("const configurable = scope === 'gym' && goalKindIsGymConfigurable(kind);");
      expect(sectionSrc).not.toMatch(/kind === 'personal'/);
    });

    it('offers Duplicate first and the availability toggle second, in the shared danger styling for Deactivate only', () => {
      expect(menu.indexOf("label('duplicate')")).toBeLessThan(menu.indexOf("label('deactivate')"));
      expect(menu.indexOf("label('deactivate')")).toBeLessThan(menu.indexOf("label('edit')"));
      const toggle = slice("available\n", "] : []),", menu);
      expect(toggle).toContain("label('deactivate')");
      expect(toggle).toContain("label('activate')");
      expect(slice("label('deactivate')", "}", toggle)).toContain('danger: true');
      expect(slice("label('activate')", "}", toggle)).not.toContain('danger');
      // Immediate, no confirmation dialog.
      expect(sectionSrc).toContain("await apiFetch(`${basePath}/${goal.id}/duplicate`, { method: 'POST' });");
      expect(slice('async function duplicate(', 'async function setAvailability(', sectionSrc)).not.toContain('ConfirmDialog');
    });

    it('reads the gym\'s availability through one helper and never the goal\'s own row', () => {
      expect(goalAvailability({ gym_status: 'inactive' })).toBe('inactive');
      expect(goalAvailability({ gym_status: 'active' })).toBe('active');
      // The platform list carries no `gym_status`, and so does a kind a gym does not configure.
      expect(goalAvailability({})).toBe('active');
      expect(sectionSrc).toContain('const status = configurable ? goalAvailability(goal) : goal.status;');
      // An inactive goal is not offered for assignment, and the item says why.
      expect(menu).toContain('disabled: !canWrite || !available');
      expect(menu).toContain("label('inactive_assign_hint')");
    });

    it('renders the standard header: Name, Description, Target, Created At, Created By, Status, Actions', () => {
      const columns = slice('const columns: Column<GoalRow>[] = [', 'const pageStart', sectionSrc);
      const headers = [...columns.matchAll(/header: (label\('[a-z_]+'\)|'')/g)].map((m) => m[1]);
      expect(headers).toEqual([
        // The thumbnail column (#1623, #1723; both kinds since #1722) leads the list.
        "label('label_image')",
        "label('label_name')", "label('label_description')", "label('col_target')",
        "label('created_at')", "label('created_by')", "label('col_status')", "''",
      ]);
      // The description is clipped in the row and whole elsewhere; the stored value is untouched.
      expect(columns).toContain('truncateDescription(translated ? (goal.display_description ?? goal.description) : goal.description)');
      expect(truncateDescription('Short')).toBe('Short');
      expect(truncateDescription('a'.repeat(100))).toBe(`${'a'.repeat(80)}…`);
      expect(truncateDescription('word '.repeat(30).trim()).endsWith('…')).toBe(true);
      expect(truncateDescription(null)).toBe('');
      // Created At is the standard formatter; Created By the masked snapshot.
      expect(columns).toContain('formatTimestamp(goal.created_at, gymFmt)');
      expect(columns).toContain('displayValue(goal.created_by)');
      expect(columns).not.toContain("label('col_type')");
    });

    it('labels every new action and state in every locale', () => {
      for (const code of ['en', 'es', 'ca'] as const) {
        const ns = (locales as any)[code] as Record<string, string>;
        for (const key of ['duplicate', 'duplicated', 'activate', 'deactivate', 'activated', 'deactivated', 'status_inactive', 'inactive_assign_hint', 'created_at', 'created_by']) {
          expect(typeof ns[key], `${code}.goal_library.${key}`).toBe('string');
        }
      }
    });

    it('keeps the pickers to goals the gym offers', () => {
      for (const file of ['AssignedPersonalGoalsSection.tsx', 'MemberPersonalGoals.tsx']) {
        const src = readFileSync(join(__dirname, '..', 'components', 'personalGoals', file), 'utf-8');
        expect(src, file).toContain("data.items.filter((goal) => goalAvailability(goal) === 'active')");
      }
    });
  });

  it('renders the inline form in the row, never a modal (#800)', () => {
    expect(sectionSrc).not.toContain('CrudModal');
    expect(sectionSrc).toContain('renderExpanded');
    // The inline form carries its own error line and its disabled-while-saving
    // state, which a modal used to give it.
    expect(sectionSrc).toContain('formErrorStyle');
    expect(sectionSrc).toContain('disabled={saving}');
  });

  it('creates inline from the same form body (#805)', () => {
    expect(sectionSrc).toContain('renderInlineForm(\n            newForm');
    expect(sectionSrc).toContain('renderInlineForm(\n              editForm');
  });
});

describe('chrome (#724, #912, #929)', () => {
  it('reads its filter bar, badges and buttons from the shared modules', () => {
    expect(sectionSrc).toContain("from '@/components/FilterBar'");
    expect(sectionSrc).toContain('listNameBadgeStyle');
    expect(sectionSrc).toContain('primaryBtnStyle()');
    expect(sectionSrc).toContain('primaryBtnSmall()');
    expect(sectionSrc).toContain('secondaryBtnSmall');
    expect(sectionSrc).toContain('formValueStyle');
  });

  it('carries no colour of its own', () => {
    // Every colour is a shared style's or a CSS variable's, and the only hex
    // allowed is a `var()` fallback for the frames before applyTokens() has run
    // (#912) — never a second source of truth for an action's colour.
    const withoutVarFallbacks = sectionSrc.replace(/var\(--[^)]*\)/g, '');
    expect(withoutVarFallbacks.match(/#[0-9a-fA-F]{3,6}\b/g) ?? []).toEqual([]);
  });

  it('shows a row\'s state through StatusBadge, in its own column', () => {
    expect(sectionSrc).toContain('<StatusBadge');
    expect(sectionSrc).toContain("label(`status_${status}`)");
  });
});

describe('locale keys', () => {
  // Every key the three components resolve, beyond the per-slug ones asserted
  // above. `<kind>_` keys are per catalogue (§7's add button among them).
  const SHARED_KEYS = [
    'tab_foods', 'tab_nutrition_goals',
    'title_personal_goals', 'title_base_personal_goals',
    'search', 'search_placeholder', 'label_name', 'label_description',
    'col_type', 'col_status', 'status_active', 'status_deleted',
    'ownership', 'ownership_system', 'ownership_gym',
    'details', 'edit', 'delete', 'cancel', 'create', 'save', 'saving', 'close',
    'loading', 'error_required', 'error_generic',
    'section_audit', 'created_at', 'created_by', 'modified_at', 'modified_by',
    'deleted_at', 'deleted_by',
  ];
  const KIND_KEYS = ['add', 'empty', 'delete_confirm'];

  it('are present in en, es and ca', () => {
    for (const [code, ns] of Object.entries(locales)) {
      for (const key of SHARED_KEYS) {
        expect(ns[key], `${code}.json goal_library.${key} is missing`).toBeTruthy();
      }
      for (const kind of GOAL_KINDS) {
        for (const key of KIND_KEYS) {
          expect(ns[`${kind}_${key}`], `${code}.json goal_library.${kind}_${key} is missing`).toBeTruthy();
        }
      }
    }
  });

  it('name each catalogue in its own add button rather than interpolating a noun', () => {
    for (const [code, ns] of Object.entries(locales)) {
      expect(ns.personal_add, code).not.toBe(ns.nutrition_add);
      for (const kind of GOAL_KINDS) {
        expect(ns[`${kind}_add`], code).not.toContain('{');
      }
    }
  });

  it('keep the three namespaces in step', () => {
    const en = Object.keys(locales.en).sort();
    for (const code of ['es', 'ca'] as const) {
      expect(Object.keys(locales[code]).sort(), code).toEqual(en);
    }
  });
});

describe('Personal Goals is its own section (#948 §1, §3, §5, §6, §8, §9)', () => {
  it('renders the shared section rather than a second goals editor', () => {
    for (const [name, src] of [['gym', personalPageSrc], ['cordel', cordelPersonalPageSrc]] as const) {
      expect(src, `${name} page does not render GoalLibrarySection`).toContain('<GoalLibrarySection');
      expect(src).toContain("from '@/components/goalLibrary/GoalLibrarySection'");
      expect(src).toContain('kind="personal"');
      // The whole point of the move is that nothing about the catalogue changed:
      // the list, the search, the `+ Add`, the inline forms and the `⋮` menu are
      // the component's, so neither page may grow one of its own.
      for (const control of ['<input', '<select', '<textarea', 'DataTable', 'ContextMenu']) {
        expect(src, `${name} page restates ${control}`).not.toContain(control);
      }
    }
  });

  it('supplies the scope each side talks to, and no endpoint of its own', () => {
    expect(personalPageSrc).toContain('scope="gym"');
    expect(cordelPersonalPageSrc).toContain('scope="platform"');
    for (const src of [personalPageSrc, cordelPersonalPageSrc]) {
      expect(src).not.toContain('/personal-goals');
      expect(src).not.toContain('apiFetch');
    }
  });

  it('keeps the gym page on the NUTRITION module and the platform page on none', () => {
    // #806: the permission is the page's, never the shared section's.
    // #1070: the module, read through Personal Goals' own feature key, whose
    // permission override the API enforces on the very routes this page calls.
    expect(personalPageSrc).toContain("useModuleAccess('NUTRITION', 'nutrition.personal_goals')");
    expect(personalPageSrc).toContain('canWrite={canWrite}');
    expect(cordelPersonalPageSrc).not.toContain('useModuleAccess');
    expect(cordelPersonalPageSrc).toMatch(/canWrite\s*$/m);
  });

  it('resolves its labels in the shared goal_library namespace', () => {
    for (const src of [personalPageSrc, cordelPersonalPageSrc]) {
      expect(src).toContain("useTranslations('goal_library')");
    }
    expect(personalPageSrc).toContain("tGoals('title_personal_goals')");
    expect(cordelPersonalPageSrc).toContain("tGoals('title_base_personal_goals')");
    for (const [code, ns] of Object.entries(locales)) {
      for (const key of ['title_personal_goals', 'title_base_personal_goals']) {
        expect(ns[key], `${code}.json goal_library.${key} is missing`).toBeTruthy();
      }
    }
  });

  it('names the group Nutrition & Goals in every language (§1)', () => {
    const group = (code: string) =>
      JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')).nav.groups.nutrition as string;
    expect(group('en')).toBe('Nutrition & Goals');
    for (const code of LOCALE_CODES) {
      // A rename, not a removal: the word for Nutrition stays in the label.
      expect(group(code), code).toMatch(/Nutri/);
      expect(group(code), code).not.toBe('Nutrition');
    }
  });

  it('adds the two nav items and keeps every existing Nutrition item (§2)', () => {
    expect(navSrc).toContain("href: '/{{locale}}/personal-goals'");
    expect(navSrc).toContain("labelKey: 'nav.personal_goals'");
    expect(navSrc).toContain("href: '/{{locale}}/cordel/personal-goals'");
    expect(navSrc).toContain("labelKey: 'nav.base_personal_goals'");
    // §2 — nothing under Nutrition was removed or re-pointed.
    for (const href of [
      "'/{{locale}}/nutrition'",
      "'/{{locale}}/nutrition/nutrition-library'",
      "'/{{locale}}/nutrition/nutrition-plan-templates'",
      "'/{{locale}}/nutrition/nutrition-plans'",
      "'/{{locale}}/cordel/nutrition-library'",
      "'/{{locale}}/cordel/nutrition-plan-templates'",
    ]) {
      expect(navSrc, `${href} is gone`).toContain(`href: ${href}`);
    }
    for (const [code, ns] of Object.entries(
      Object.fromEntries(LOCALE_CODES.map((c) => [
        c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8')).nav as Record<string, string>,
      ])),
    )) {
      for (const key of ['personal_goals', 'base_personal_goals']) {
        expect(ns[key], `${code}.json nav.${key} is missing`).toBeTruthy();
      }
    }
  });

  it('does not nest the route under /nutrition (§8)', () => {
    expect(navSrc).not.toContain("'/{{locale}}/nutrition/personal-goals'");
  });

  it('gates the gym list on its own feature flag, not the Nutrition Library\'s', () => {
    // A section of a different domain must not be hidden by hiding Foods.
    // #1070: the module gate reads the same key beside it, so a feature-level
    // permission override applies to exactly this section.
    expect(apiAppSrc).toContain(
      "app.use('/personal-goals', requireAuth(), tenantContext, requireFeatureAccess('nutrition.personal_goals', 'NUTRITION'), requireFeatureEnabled('nutrition.personal_goals')",
    );
    expect(navSrc).toContain("featureKey: 'nutrition.personal_goals'");
    // Nutrition Goals is still a tab of the Nutrition Library, so it keeps its key.
    expect(apiAppSrc).toContain(
      "app.use('/nutrition-goals', requireAuth(), tenantContext, requireFeatureAccess('nutrition.nutrition_library', 'NUTRITION'), requireFeatureEnabled('nutrition.nutrition_library')",
    );
  });
});

/**
 * #1722 — a Personal Goal's image is the shared WebP pipeline's, drawn by the
 * section's one control (`MemberImageField`), like a Nutrition Goal's.
 */
describe('a Personal Goal has the WebP image pair (#1722)', () => {
  const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

  it('carries no second image declaration and no PNG-only control', () => {
    expect(existsSync(join(__dirname, '..', 'components/goalLibrary/GoalImageField.tsx'))).toBe(false);
    const section = read('components/goalLibrary/GoalLibrarySection.tsx');
    expect(section).not.toContain('GoalImageField');
    expect(section).not.toContain('ReadOnlyImage');
    expect(section).not.toContain('goalKindHasImage');
    const profile = read('components/goalLibrary/goalProfile.ts');
    expect(profile).not.toContain('export const IMAGE_GOAL_KINDS');
    expect(profile).not.toContain('PERSONAL_GOAL_IMAGE_MAX_SIZE');
  });

  it('renders the one MemberImageField behind the kind that has an image, with the create half offering none', () => {
    const section = read('components/goalLibrary/GoalLibrarySection.tsx');
    expect(section).toContain('goalKindHasWebpImage');
    expect(section).toContain('<MemberImageField');
    expect(section).toContain("label('image_after_create')");
  });

  it('has every key the control resolves, in all three locales, and no PNG-only sentence', () => {
    const keys = [
      'label_image', 'image_none', 'image_requirements', 'image_upload', 'image_replace',
      'image_remove', 'image_uploading', 'image_removing', 'image_confirm_remove',
      'image_after_create', 'image_not_configured', 'image_not_initialized',
      'image_error_unreadable', 'image_error_upload_failed', 'image_error_remove_failed',
    ];
    for (const locale of ['en', 'es', 'ca']) {
      const messages = JSON.parse(
        readFileSync(join(__dirname, '../../locales/base', `${locale}.json`), 'utf8'),
      );
      for (const key of keys) {
        expect(messages.goal_library[key], `${locale}.goal_library.${key}`).toBeTruthy();
      }
      expect(messages.goal_library.image_requirements).not.toMatch(/512/);
      expect(messages.goal_library.image_error_not_a_png).toBeUndefined();
    }
  });
});

/**
 * #1623 — a Nutrition Goal carries a WebP image and a translated name and
 * description, and each declaration is mirrored from the API's.
 */
describe('a Nutrition Goal is translated; both kinds carry a WebP image (#1623, #1722)', () => {
  it("mirrors the API's declarations", () => {
    expect([...WEBP_IMAGE_GOAL_KINDS]).toEqual([...API_WEBP_IMAGE_GOAL_KINDS]);
    expect([...TRANSLATED_GOAL_KINDS]).toEqual([...API_TRANSLATED_GOAL_KINDS]);
    expect(goalKindIsTranslated('nutrition')).toBe(true);
    expect(goalKindIsTranslated('personal')).toBe(false);
  });

  const row: GoalRow = {
    id: 1, gym_id: null, slug: 'protein', name: 'Protein', description: 'Base', status: 'active',
    created_at: '2026-01-01T00:00:00Z', created_by: null, modified_at: null, modified_by: null, deleted_at: null, deleted_by: null,
  };

  it('shows the API\'s display_name for a translated kind, the slug rule for the other', () => {
    const translate = (key: string) => `T:${key}`;
    expect(goalListName({ ...row, display_name: 'Proteínas' }, 'nutrition', translate)).toBe('Proteínas');
    expect(goalListName(row, 'nutrition', translate)).toBe('Protein');
    expect(goalListName({ ...row, slug: 'weight_loss', name: 'Weight Loss' }, 'personal', translate)).toBe('T:personal_goal_weight_loss');
  });

  it('seeds the form from the row\'s translations and submits only locales with a name', () => {
    const form = toGoalFormValues({
      ...row, translations: { es: { name: 'Proteínas', description: null }, ca: { name: '', description: null } },
    });
    expect(form.translations).toEqual({
      es: { name: 'Proteínas', description: '' }, ca: { name: '', description: '' },
    });
    expect(toGoalPayload({ ...form, name: 'Protein' }, 'nutrition').translations)
      .toEqual({ es: { name: 'Proteínas', description: null } });
    expect(toTranslationsPayload({ es: { name: ' ', description: 'x' } })).toEqual({});
  });

  it('leaves a Personal Goal\'s form and payload exactly as they were', () => {
    expect(toGoalFormValues({ ...row, slug: null }).translations).toBeUndefined();
    expect(toGoalPayload({ ...emptyGoalForm(), name: 'x', translations: { es: { name: 'y', description: '' } } }, 'personal').translations)
      .toBeUndefined();
  });

  it('refuses a translated description without a translated name', () => {
    expect(goalFormError({
      ...emptyGoalForm(), name: 'x', translations: { es: { name: '', description: 'sin nombre' } },
    }, 'nutrition')).toBe('error_translation_name');
  });
});
