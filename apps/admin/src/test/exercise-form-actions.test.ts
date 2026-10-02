import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { primaryBtnSmall, primaryBtnStyle, btnStyle } from '@/components/ui';
import { inlineActionsRowStyle, formActionsRowStyle, secondaryBtnSmall, formErrorStyle } from '@/components/formChrome';

// #968 — the Base Exercise form's actions were a right-aligned pair with a grey
// `Cancel` of the form's own, and its two upload pickers spelled the legacy
// lilac. They now wear the platform's chrome: the left-aligned inline actions
// row, `secondaryBtnSmall` for Cancel, and the Theme's Primary Button pair for
// every filled action in the view.
//
// `apps/admin` has no component-test infra (docs/architecture.md's TL;DR), so
// the shared styles are asserted directly and the wiring is pinned by scanning
// the sources — exactly as #912/#954's own test does.

const SRC = join(__dirname, '..');
const EDITOR = join(SRC, 'components', 'exercises', 'ExerciseEditor.tsx');
const IMAGE_FIELD = join(SRC, 'components', 'ExerciseImageField.tsx');
const VIDEO_FIELD = join(SRC, 'components', 'ExerciseVideoField.tsx');
const BASE_PAGE = join(SRC, 'app', '[locale]', 'cordel', 'exercises', 'page.tsx');
const GYM_PAGE = join(SRC, 'app', '[locale]', 'exercises', 'page.tsx');

/** Each file's comments name the lilac to explain what was removed. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}
const read = (path: string) => stripComments(readFileSync(path, 'utf-8'));

const editorSrc = read(EDITOR);
const imageSrc = read(IMAGE_FIELD);
const videoSrc = read(VIDEO_FIELD);
const basePageSrc = read(BASE_PAGE);

describe('The form actions are the platform\'s left-aligned inline row (#968 §3)', () => {
  it('renders the shared row style rather than a layout of its own', () => {
    expect(editorSrc).toContain('<div style={inlineActionsRowStyle}>');
    expect(editorSrc).toMatch(/import \{[^}]*\binlineActionsRowStyle\b[^}]*\} from '@\/components\/formChrome'/);
  });

  it('left-aligns, because the shared row declares no justification', () => {
    // The distinction this ticket is about: `formActionsRowStyle` is the
    // right-aligned card-level pair, `inlineActionsRowStyle` the left-aligned
    // section-level one. A `justifyContent` here would re-create the defect.
    expect(inlineActionsRowStyle.justifyContent).toBeUndefined();
    expect(formActionsRowStyle.justifyContent).toBe('flex-end');
    expect(inlineActionsRowStyle.display).toBe('flex');
    expect(editorSrc).not.toContain('flex-end');
  });

  it('keeps the actions at the form\'s own content margin', () => {
    // No padding or inset of its own: the row sits in the form body's flow, so
    // the buttons line up with the fields above them.
    expect(inlineActionsRowStyle.padding).toBeUndefined();
    expect(inlineActionsRowStyle.paddingTop).toBeUndefined();
    expect(inlineActionsRowStyle.marginLeft).toBeUndefined();
  });
});

describe('Save is themed, Cancel is the platform secondary (#968 §1, §2)', () => {
  it('renders exactly one primary and one secondary button', () => {
    expect(editorSrc).toContain('style={secondaryBtnSmall}');
    expect(editorSrc).toContain('style={primaryBtnSmall()}');
    expect(editorSrc.match(/style=\{primaryBtnSmall\(\)\}/g) ?? []).toHaveLength(1);
    expect(editorSrc).toMatch(/import \{[^}]*\bsecondaryBtnSmall\b[^}]*\} from '@\/components\/formChrome'/);
    expect(editorSrc).toMatch(/import \{[^}]*\bprimaryBtnSmall\b[^}]*\} from '@\/components\/ui'/);
  });

  it('drops the grey Cancel this form used to spell for itself', () => {
    expect(editorSrc).not.toContain("btnSmall('#888')");
    expect(editorSrc).not.toContain('#6c63ff');
  });

  it('keeps Cancel visually subordinate at the same geometry', () => {
    // §2/§3: the pair is the same height and the same radius; only the colours
    // differ, which is what makes the hierarchy read.
    expect(secondaryBtnSmall.padding).toBe(primaryBtnSmall().padding);
    expect(secondaryBtnSmall.fontSize).toBe(primaryBtnSmall().fontSize);
    expect(secondaryBtnSmall.background).toBe('var(--gd-input-bg, #ffffff)');
    expect(primaryBtnSmall().background).toBe('var(--gd-primary-btn, #6c63ff)');
  });

  it('reports a failed save on the shared form error line', () => {
    expect(editorSrc).toContain('<p style={formErrorStyle}>{state.error}</p>');
    expect(formErrorStyle.color).toBe('#c0392b');
  });

  it('keeps the Save button\'s behaviour exactly as it was (#968 AC11)', () => {
    expect(editorSrc).toContain('onClick={onSave} disabled={state.saving}');
    expect(editorSrc).toContain("{state.saving ? t('saving') : primaryLabel}");
    expect(editorSrc).toContain("<button onClick={onCancel}");
  });
});

describe('The Media pickers follow the Theme (#968 §6, AC8, AC9)', () => {
  it('renders Upload Image and Upload Video through the shared primary helper', () => {
    for (const src of [imageSrc, videoSrc]) {
      expect(src).toContain('style={primaryBtnSmall()}');
      expect(src).not.toContain("btnSmall('#6c63ff')");
      expect(src).not.toContain('#6c63ff');
      expect(src).toMatch(/import \{[^}]*\bprimaryBtnSmall\b[^}]*\} from '\.\/ui'/);
    }
  });

  it('leaves each picker\'s position, gating and Remove button untouched', () => {
    for (const src of [imageSrc, videoSrc]) {
      // §6: only the colour moved. The hidden <input> is still disabled with
      // the button (#823), and `Remove` is still the neutral grey.
      expect(src).toContain('disabled={blocked || busy !== null}');
      expect(src).toContain("btnSmall('#888')");
      expect(src).toContain('onClick={() => inputRef.current?.click()}');
    }
  });
});

describe('The Base Exercises page\'s own primary action is themed (#968 §5)', () => {
  it('uses the same helper the gym Exercises page already used', () => {
    expect(basePageSrc).toContain('style={primaryBtnStyle()}');
    expect(basePageSrc).not.toContain('style={btnStyle()}');
    expect(read(GYM_PAGE)).toContain('readOnlyStyle(primaryBtnStyle(), !canWrite)');
  });

  it('is not the sidebar\'s colour, which is what btnStyle() resolves to', () => {
    // CLAUDE.md: `--brand` is sidebarSelectedItemBackground. `+ New Exercise`
    // followed it, so theming Buttons → Primary Button moved every other page's
    // Add button and not this one.
    expect(btnStyle().background).toBe('var(--brand, #6c63ff)');
    expect(primaryBtnStyle().background).toBe('var(--gd-primary-btn, #6c63ff)');
    expect(basePageSrc).not.toContain('--brand');
  });
});
