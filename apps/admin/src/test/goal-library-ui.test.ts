import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  GOAL_API_ROOTS,
  GOAL_AUDIT_ENTITIES,
  GOAL_KINDS,
  LIBRARY_TABS,
  SYSTEM_GOAL_SLUGS,
  emptyGoalForm,
  goalDisplayName,
  isGoalTab,
  isSystemGoal,
  toGoalFormValues,
  toGoalPayload,
  type GoalRow,
} from '@/components/goalLibrary/goalProfile';
// The declarations this page mirrors are the API's — imported directly, the way
// permission-matrix-parity.test.ts does, so the two cannot drift silently.
import {
  GOAL_LIBRARY_AUDIT_ENTITIES,
  GOAL_LIBRARY_KINDS,
  SYSTEM_GOALS,
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
const modalSrc = read('components', 'goalLibrary', 'GoalDetailsModal.tsx');
const gymPageSrc = read('app', '[locale]', 'nutrition', 'nutrition-library', 'page.tsx');
const cordelPageSrc = read('app', '[locale]', 'cordel', 'nutrition-library', 'page.tsx');
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
  it('declares exactly three tabs, Foods first', () => {
    expect(LIBRARY_TABS.map((t) => t.id)).toEqual(['foods', 'personal', 'nutrition']);
  });

  it('separates the goal tabs from Foods', () => {
    expect(isGoalTab('foods')).toBe(false);
    expect(isGoalTab('personal')).toBe(true);
    expect(isGoalTab('nutrition')).toBe(true);
    // A goal tab is a goal kind, so a tab can never name a catalogue that does
    // not exist.
    expect(LIBRARY_TABS.filter((t) => isGoalTab(t.id)).map((t) => t.id)).toEqual([...GOAL_KINDS]);
  });

  it('is one component, rendered by both libraries', () => {
    for (const [name, src] of [['gym', gymPageSrc], ['cordel', cordelPageSrc]] as const) {
      expect(src, `${name} page does not render LibraryTabs`).toContain('<LibraryTabs');
      expect(src).toContain("from '@/components/goalLibrary/LibraryTabs'");
      expect(src).toContain('<GoalLibrarySection');
    }
  });

  it('renders the tab strip from the declaration, never a hardcoded list', () => {
    expect(tabsSrc).toContain('LIBRARY_TABS.map');
    for (const tab of LIBRARY_TABS) {
      expect(tabsSrc).not.toContain(`'${tab.labelKey}'`);
    }
  });

  it('marks the selected tab for assistive technology', () => {
    expect(tabsSrc).toContain('role="tablist"');
    expect(tabsSrc).toContain('role="tab"');
    expect(tabsSrc).toContain('aria-selected={selected}');
  });

  it('shows the goal sections for both kinds, with each library\'s own scope', () => {
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
    created_by_name: 'Staff',
    modified_at: null,
    modified_by_name: null,
    deleted_at: null,
    deleted_by_name: null,
  };

  it('tells a System row from a gym\'s own', () => {
    expect(isSystemGoal(row)).toBe(false);
    expect(isSystemGoal({ ...row, gym_id: null })).toBe(true);
  });

  it('seeds the Edit form from the persisted row', () => {
    expect(toGoalFormValues(row)).toEqual({ name: 'Competition Preparation', description: '  the season  ' });
    expect(toGoalFormValues({ ...row, description: null })).toEqual({
      name: 'Competition Preparation', description: '',
    });
    expect(emptyGoalForm()).toEqual({ name: '', description: '' });
  });

  it('submits a trimmed description as `` so clearing it persists', () => {
    // The routers read an empty string as "clear it" and an absent key as "leave
    // it alone", so the key is always present.
    expect(toGoalPayload({ name: ' Energy ', description: '   ' })).toEqual({ name: 'Energy', description: '' });
    expect(toGoalPayload({ name: 'Energy', description: ' x ' })).toEqual({ name: 'Energy', description: 'x' });
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

  it('gates both writes on the page\'s own permission', () => {
    const menu = slice('<ContextMenu items={[', '/>', sectionSrc);
    expect(menu.match(/disabled: !canWrite/g)?.length).toBe(2);
    // The section decides no permission of its own (#806).
    expect(sectionSrc).not.toContain('useModuleAccess');
  });

  it('keeps a System row read-only in a gym\'s library (§5)', () => {
    expect(sectionSrc).toContain("scope === 'platform' || !isSystemGoal(goal)");
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
    expect(sectionSrc).toContain("label(`status_${goal.status}`)");
  });
});

describe('locale keys', () => {
  // Every key the three components resolve, beyond the per-slug ones asserted
  // above. `<kind>_` keys are per catalogue (§7's add button among them).
  const SHARED_KEYS = [
    'tab_foods', 'tab_personal_goals', 'tab_nutrition_goals',
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
