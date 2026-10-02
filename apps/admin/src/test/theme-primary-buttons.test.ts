import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { primaryActionColors, primaryBtnSmall, primaryBtnStyle, btnSmall, btnStyle } from '@/components/ui';
import { DEFAULT_TOKENS, applyTokens } from '@/lib/themeTokens';

// #912 — the Theme editor's own primary actions (`+ Assign Centers…`, `Save
// changes` on both Theme screens, `+ Add` on Base Themes) were rendered in the
// legacy hardcoded lilac and did not move when a gym changed its Theme's
// Primary Button colour. They now take `--gd-primary-btn` /
// `--gd-primary-btn-text` — the existing Buttons group `SectionEditButton`
// already consumes (#901) — with no new Theme setting introduced.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so —
// like section-edit-button.test.ts — the shared style is asserted directly and
// the page wiring is pinned by scanning the sources.

const SRC = join(__dirname, '..');
const UI = join(SRC, 'components', 'ui.tsx');
const GYM_THEMES = join(SRC, 'app', '[locale]', 'themes', 'page.tsx');
const BASE_THEMES = join(SRC, 'app', '[locale]', 'system', 'themes', 'page.tsx');

// Every file's comments name the old lilac to explain what was removed, so the
// scans below run on comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const uiSrc = read(UI);
const gymSrc = read(GYM_THEMES);
const baseSrc = read(BASE_THEMES);

describe('primaryActionColors: the Theme Buttons group, in one place (#912 §3, §5)', () => {
  it('reads both variables applyTokens writes for the Buttons group', () => {
    expect(primaryActionColors.background).toBe('var(--gd-primary-btn, #6c63ff)');
    expect(primaryActionColors.color).toBe('var(--gd-primary-btn-text, #ffffff)');
  });

  it('uses the shipped Theme defaults as the var() fallbacks', () => {
    // The fallback covers the frames before `applyTokens` has run, so it has to
    // be the value an unthemed gym resolves to — otherwise the button flashes a
    // colour no Theme ever configured.
    expect(primaryActionColors.background).toContain(`, ${DEFAULT_TOKENS.colors.primaryButton})`);
    expect(primaryActionColors.color).toContain(`, ${DEFAULT_TOKENS.colors.primaryButtonText})`);
  });

  it('is not the same thing as dropping btnStyle/btnSmall\'s argument', () => {
    // Their own default is `--brand`, which `applyTokens` maps to
    // `sidebarSelectedItemBackground` — a different Theme setting, and not an
    // action colour. That is why a primary action spreads the pair explicitly.
    expect(btnStyle().background).toBe('var(--brand, #6c63ff)');
    expect(btnSmall().background).toBe('var(--brand, #6c63ff)');
    expect(primaryBtnStyle().background).not.toBe(btnStyle().background);
    expect(primaryBtnSmall().background).not.toBe(btnSmall().background);
  });

  it('keeps each helper\'s geometry and only replaces its colours', () => {
    for (const [themed, plain] of [
      [primaryBtnStyle(), btnStyle()],
      [primaryBtnSmall(), btnSmall()],
    ] as const) {
      expect({ ...themed, ...primaryActionColors }).toEqual(themed);
      for (const key of ['border', 'borderRadius', 'padding', 'cursor', 'fontSize'] as const) {
        expect(themed[key]).toBe(plain[key]);
      }
      expect(themed.color).toBe(primaryActionColors.color);
      expect(themed.background).toBe(primaryActionColors.background);
    }
  });

  it('introduces no Theme token of its own', () => {
    // §4/§5: the existing `primaryButton` / `primaryButtonText` are reused. A
    // new `--gd-*` variable spelled in `ui.tsx` would be a Theme setting with
    // no editor behind it.
    const vars = uiSrc.match(/--gd-[a-z-]+/g) ?? [];
    expect(vars).toContain('--gd-primary-btn');
    expect(vars).toContain('--gd-primary-btn-text');
    expect(vars.filter((v) => v.startsWith('--gd-primary'))).toEqual(['--gd-primary-btn', '--gd-primary-btn-text']);
  });
});

describe('Both Theme screens render their primary actions themed (#912 §1, §2)', () => {
  it('the gym Theme editor does, for + Assign Centers and Save changes', () => {
    expect(gymSrc).toContain('primaryBtnSmall');
    expect(gymSrc.match(/\.\.\.primaryBtnSmall\(\)/g) ?? []).toHaveLength(2);
    expect(gymSrc).toContain("{t('assign_centers_btn')}");
  });

  it('the Base Theme screen does, for Save changes and + Add', () => {
    expect(baseSrc.match(/\.\.\.primaryBtnSmall\(\)/g) ?? []).toHaveLength(1);
    expect(baseSrc).toContain('style={primaryBtnStyle()}');
  });

  it('leaves no hardcoded lilac in either screen\'s buttons', () => {
    // The gym screen keeps one `#6c63ff`: the "show all centers" disclosure
    // text link, which is not a primary action and is deliberately out of
    // scope (§4). Neither screen may carry one on a <button> style helper.
    for (const src of [gymSrc, baseSrc]) {
      expect(src).not.toContain("btnSmall('#6c63ff')");
      expect(src).not.toContain("btnStyle('#6c63ff')");
    }
    expect(baseSrc.match(/#6c63ff/g) ?? []).toEqual([]);
    expect(gymSrc.match(/#6c63ff/g) ?? []).toHaveLength(1);
    expect(gymSrc).toContain("color: '#6c63ff', cursor: 'pointer'");
  });

  it('preserves the disabled affordance each button already had', () => {
    // §6: the spread only replaces the colours — the opacity/cursor pair that
    // marks a Save with nothing to save, and a picker on a non-active Theme,
    // still rides on top of it.
    expect(gymSrc).toContain("...primaryBtnSmall(), opacity: canAssign ? 1 : 0.5, cursor: canAssign ? 'pointer' : 'not-allowed'");
    expect(gymSrc).toContain("...primaryBtnSmall(), opacity: (saving || !dirty) ? 0.5 : 1");
    expect(baseSrc).toContain('...primaryBtnSmall(), opacity: (editSaving || !isDirty()) ? 0.5 : 1');
    expect(baseSrc).toContain('disabled={hasNewRow}');
  });

  it('leaves the secondary and destructive buttons alone', () => {
    // §4: Cancel stays grey, an upload stays neutral, a remove stays red.
    for (const src of [gymSrc, baseSrc]) {
      expect(src).toContain("btnSmall('#888')");
    }
  });
});

// ── #954 ────────────────────────────────────────────────────────────────────
//
// #912 themed the two Theme screens' own primary actions; the rest of the Admin
// app was still spelling the legacy lilac out, so a gym that configured
// Buttons → Primary Button saw it on `Save changes` in the Theme editor and
// nowhere else. Every *filled* primary action across the app now takes the same
// pair, through the same two helpers — no new token, no new helper, and no
// geometry change.
//
// The scan below is the enforcement: `apps/admin` has no component-test infra
// (docs/architecture.md's TL;DR), so a page's wiring is pinned by reading its
// source, exactly as #912 and #901 do.

const APP = join(SRC, 'app');
const COMPONENTS = join(SRC, 'components');

/**
 * The file-picker controls that still keep their own colour: a file picker is
 * not its form's primary action (its Save is), so #954 left all three out of
 * the sweep and named them here, "so theming them later is a decision someone
 * makes, not a line someone forgets".
 *
 * #968 is that decision, for the two Exercise media controls: the Base Exercise
 * form's `Upload Image` / `Upload Video` were the only lilac left in that view,
 * so they now take `primaryBtnSmall()` and are asserted as themed below
 * (`exercise-form-actions.test.ts` covers the rest of the form). The generic
 * `ImageUploadField`, which the Exercise form does not render, is unchanged and
 * stays on this list.
 */
const FILE_PICKERS = [
  join(COMPONENTS, 'ImageUploadField.tsx'),
];

/** The two pickers #968 moved onto the Theme's Primary Button pair. */
const THEMED_EXERCISE_PICKERS = [
  join(COMPONENTS, 'ExerciseImageField.tsx'),
  join(COMPONENTS, 'ExerciseVideoField.tsx'),
];

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') continue;
      out.push(...sourcesUnder(path));
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

const ADMIN_SOURCES = [...sourcesUnder(APP), ...sourcesUnder(COMPONENTS), ...sourcesUnder(join(SRC, 'lib'))];

describe('No primary action in the Admin app is hardcoded lilac (#954 §1, §2)', () => {
  it('scans a realistic share of the app, not a handful of files', () => {
    // A guard on the guard: if the walk ever stops finding sources, every
    // assertion below passes vacuously.
    expect(ADMIN_SOURCES.length).toBeGreaterThan(100);
    expect(ADMIN_SOURCES).toContain(join(COMPONENTS, 'ui.tsx'));
  });

  it('calls neither button helper with the lilac argument', () => {
    const offenders = ADMIN_SOURCES.filter((path) => {
      if (FILE_PICKERS.includes(path)) return false;
      const src = read(path);
      return src.includes("btnStyle('#6c63ff')") || src.includes("btnSmall('#6c63ff')");
    });
    expect(offenders.map((p) => p.slice(SRC.length + 1))).toEqual([]);
  });

  it('assigns the lilac as a flat background nowhere', () => {
    // The inline primary actions in the two calendar detail panels carried their
    // own geometry and spelled `background: '#6c63ff', color: '#fff'` out; they
    // spread `primaryActionColors` now. A `var(--brand, #6c63ff)` or a ternary
    // on a selected filter chip is a different question and is left alone (§5).
    const offenders = ADMIN_SOURCES.filter((path) => read(path).includes("background: '#6c63ff'"));
    expect(offenders.map((p) => p.slice(SRC.length + 1))).toEqual([]);
  });

  it('routes every themed primary action through the two existing helpers', () => {
    // §2: no third helper, and no page spelling `var(--gd-primary-btn)` for
    // itself — `ui.tsx` stays the only place the pair is *read*, beside
    // `themeTokens.ts`, which is the `applyTokens` writer that puts it there.
    const NAMES_THE_VARIABLE = [join(COMPONENTS, 'ui.tsx'), join(SRC, 'lib', 'themeTokens.ts')];
    const spelled = ADMIN_SOURCES.filter(
      (path) => !NAMES_THE_VARIABLE.includes(path) && read(path).includes('--gd-primary-btn'),
    );
    expect(spelled.map((p) => p.slice(SRC.length + 1))).toEqual([]);

    const callers = ADMIN_SOURCES.filter(
      (path) => path !== join(COMPONENTS, 'ui.tsx') && /\bprimaryBtn(Style|Small)\(\)/.test(read(path)),
    );
    expect(callers.length).toBeGreaterThan(30);
    for (const path of callers) {
      expect(read(path), `${path} calls a primary helper without importing it`)
        .toMatch(/import \{[^}]*\bprimaryBtn(Style|Small)\b[^}]*\} from '(\.\/ui|@\/components\/ui)'/);
    }
  });

  it('keeps the disabled / read-only affordance each converted button had', () => {
    // §4: only the colours moved. A write control a read-only role may not use
    // is still wrapped in `readOnlyStyle`, which dims the themed colours the
    // same way it dimmed the lilac.
    const wrapped = ADMIN_SOURCES.filter((path) => /readOnlyStyle\(primaryBtn(Style|Small)\(\)/.test(read(path)));
    expect(wrapped.length).toBeGreaterThan(8);
  });

  it('leaves the remaining file picker, the secondaries and the destructive buttons alone', () => {
    // §5: these are explicitly not primary actions. The picker keeps the colour
    // it had — this assertion is what makes changing that a decision.
    for (const path of FILE_PICKERS) {
      const src = read(path);
      expect(src, `${path} no longer renders its own picker colour`).toContain("btnSmall('#6c63ff')");
    }
    // #968: the two Exercise pickers are the ones that moved, and their neutral
    // `Remove` stayed exactly as it was.
    for (const path of THEMED_EXERCISE_PICKERS) {
      const src = read(path);
      expect(src, `${path} still spells the legacy lilac`).not.toContain('#6c63ff');
      expect(src, `${path} does not use the shared primary helper`).toContain('style={primaryBtnSmall()}');
      expect(src, `${path} lost its neutral Remove button`).toContain("btnSmall('#888')");
    }
    expect(read(join(COMPONENTS, 'ImageUploadField.tsx'))).toContain("btnSmall('#888')");
    // A modal's Cancel is still grey, and a destructive action still red.
    expect(read(join(COMPONENTS, 'CrudModal.tsx'))).toContain("btnStyle('#aaa')");
    expect(read(join(APP, '[locale]', 'calendar', 'ClassSessionDetailPanel.tsx'))).toContain("background: '#dc2626'");
  });
});

describe('The two calendar detail panels theme their own filled actions (#954 §1)', () => {
  const eventPanel = read(join(APP, '[locale]', 'calendar', 'EventDetailsPanel.tsx'));
  const sessionPanel = read(join(APP, '[locale]', 'calendar', 'ClassSessionDetailPanel.tsx'));

  it('spreads the shared pair over each panel button\'s own geometry', () => {
    // These buttons are full-width panel actions rather than `btnStyle`
    // geometry, so they take `primaryActionColors` directly — the pair, not a
    // fourth helper. The spread sits where the two colour properties were, so
    // the `opacity`/`cursor` overrides after it still win.
    expect(eventPanel.match(/\.\.\.primaryActionColors/g) ?? []).toHaveLength(1);
    // Six since #977 added `Mark as completed` and its confirmation action.
    expect(sessionPanel.match(/\.\.\.primaryActionColors/g) ?? []).toHaveLength(6);
    for (const src of [eventPanel, sessionPanel]) {
      expect(src).toMatch(/import \{[^}]*\bprimaryActionColors\b[^}]*\} from '@\/components\/ui'/);
      expect(src).not.toContain('#6c63ff');
    }
    expect(sessionPanel).toContain("...btnBase, ...primaryActionColors, flex: 1, opacity: adding ? 0.6 : 1");
    expect(eventPanel).toContain("...primaryActionColors, fontSize: 14, fontWeight: 600");
  });
});

describe('A Theme change moves every primary action (#954 §6, expected result)', () => {
  /** Minimal `document` stand-in — these tests run in vitest's node environment. */
  function stubDocument(): Record<string, string> {
    const written: Record<string, string> = {};
    (globalThis as any).document = {
      documentElement: {
        style: { setProperty: (name: string, value: string) => { written[name] = value; } },
      },
    };
    return written;
  }

  afterEach(() => { delete (globalThis as any).document; });

  it('writes the edited Buttons group into the variables the helpers read', () => {
    const written = stubDocument();
    applyTokens({
      ...DEFAULT_TOKENS,
      colors: { ...DEFAULT_TOKENS.colors, primaryButton: '#123456', primaryButtonText: '#ffffff' },
    });
    expect(written['--gd-primary-btn']).toBe('#123456');
    expect(written['--gd-primary-btn-text']).toBe('#ffffff');

    // The link from the edited token to the rendered button: the helpers name
    // exactly the two variables `applyTokens` has just written, so the live
    // preview needs no reload and no second code path.
    for (const style of [primaryBtnStyle(), primaryBtnSmall(), primaryActionColors]) {
      expect(style.background).toContain('var(--gd-primary-btn,');
      expect(style.color).toContain('var(--gd-primary-btn-text,');
    }
  });

  it('does not reach the sidebar\'s own colour on the way', () => {
    // §3: `--brand` is `sidebarSelectedItemBackground`. A primary action that
    // resolved through it would follow the wrong Theme setting.
    const written = stubDocument();
    applyTokens({
      ...DEFAULT_TOKENS,
      colors: { ...DEFAULT_TOKENS.colors, primaryButton: '#123456', sidebarSelectedItemBackground: '#abcdef' },
    });
    expect(written['--brand']).not.toBe('#123456');
    for (const style of [primaryBtnStyle(), primaryBtnSmall()]) {
      expect(style.background).not.toContain('--brand');
    }
  });
});
