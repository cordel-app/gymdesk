import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #633 — "Only applicable for new members" on the main Promotion configuration.
//
// The flag is stored and displayed only: this ticket explicitly changes no
// eligibility, stacking or Assign-Plan-to-Member behaviour (#633 §5). What the
// UI has to get right is therefore narrow and easy to regress, so it is pinned
// here: the checkbox is checked by default on create, it sits directly below
// "Stackable with other promotions", it round-trips through the main Edit save,
// and it reads back as a read-only field when the Promotion is not being edited.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PROMOTIONS_PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const DETAIL_MODAL = join(__dirname, '..', 'app', '[locale]', 'promotions', 'PromotionDetailModal.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const LABEL_KEY = 'label_only_applicable_for_new_members';
const DETAIL_KEY = 'detail_only_applicable_for_new_members';

type Messages = Record<string, unknown>;

function promotionsKey(code: string, key: string): string | undefined {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')) as Messages;
  const ns = messages['promotions'];
  if (ns == null || typeof ns !== 'object') return undefined;
  const value = (ns as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

// The source comments name the field and the ticket, so source scans run
// against code with comments stripped.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('Promotions: "Only applicable for new members" flag (#633)', () => {
  const page = stripComments(readFileSync(PROMOTIONS_PAGE, 'utf-8'));
  const modal = stripComments(readFileSync(DETAIL_MODAL, 'utf-8'));

  it.each(LOCALE_CODES)('translates the checkbox and the read-only field in %s.json', (code) => {
    expect(promotionsKey(code, LABEL_KEY), `${code}.json is missing promotions.${LABEL_KEY}`).toBeTypeOf('string');
    expect(promotionsKey(code, DETAIL_KEY), `${code}.json is missing promotions.${DETAIL_KEY}`).toBeTypeOf('string');
  });

  it('checks the box by default on create and mirrors the stored value on edit', () => {
    expect(page).toContain('only_applicable_for_new_members: promo ? !!promo.only_applicable_for_new_members : true');
  });

  it('renders the checkbox directly below "Stackable with other promotions"', () => {
    const stackable = page.indexOf("t('label_stackable')");
    const newMembers = page.indexOf(`t('${LABEL_KEY}')`);
    expect(stackable, 'the Stackable checkbox is gone').toBeGreaterThan(-1);
    expect(newMembers, 'the new-members checkbox is not rendered').toBeGreaterThan(-1);
    expect(newMembers, 'the new-members checkbox must follow Stackable').toBeGreaterThan(stackable);
    // Nothing else may come between them — the two booleans are one group.
    expect(page.slice(stackable, newMembers)).not.toContain('inlineLabelSt');
  });

  it('sends the flag with the main Promotion configuration save', () => {
    expect(page).toContain('only_applicable_for_new_members: editForm.only_applicable_for_new_members');
  });

  it('shows the flag read-only in the Promotion detail view', () => {
    expect(modal).toContain(`t('${DETAIL_KEY}')`);
    expect(modal).toContain('detail.only_applicable_for_new_members ?');
  });

  it('adds no eligibility logic to the Assign Plan flow (#633 §5)', () => {
    const assignPlan = readFileSync(
      join(__dirname, '..', 'app', '[locale]', 'members', 'AssignPlanInlineEditor.tsx'), 'utf-8',
    );
    expect(assignPlan).not.toContain('only_applicable_for_new_members');
  });
});
