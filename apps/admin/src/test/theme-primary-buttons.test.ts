import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { primaryActionColors, primaryBtnSmall, primaryBtnStyle, btnSmall, btnStyle } from '@/components/ui';
import { DEFAULT_TOKENS } from '@/lib/themeTokens';

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
