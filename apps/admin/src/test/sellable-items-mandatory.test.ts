import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #832 — the Mandatory checkbox on Sellable Items.
//
// The ticket adds the attribute and its UI only: no Billing Plan behaviour is
// attached to it yet. Both kinds of row the page holds are covered by one
// control — the per-gym System items seeded from `charge_types` (the ticket's
// "Base Sellable Items") and the gym's own ("Custom") — so what is easy to
// regress is narrow and pinned here: the checkbox exists in both halves of the
// form, it is *not* hidden for a System item the way the catalogue-shape fields
// are, both forms submit it, and the read-only surfaces show it.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PAGE = join(__dirname, '..', 'app', '[locale]', 'financials', 'sellable-items', 'page.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const KEYS = ['label_mandatory', 'yes', 'no'] as const;

function sellableItemsKey(code: string, key: string): string | undefined {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')) as Record<string, unknown>;
  const ns = messages['sellable_items'];
  if (ns == null || typeof ns !== 'object') return undefined;
  const value = (ns as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

// The source comments name the field and the ticket, so source scans run
// against code with comments stripped.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('Sellable Items: Mandatory attribute (#832)', () => {
  const page = stripComments(readFileSync(PAGE, 'utf-8'));
  // #974: the field set and the row → form mapping live beside the page.
  const profile = stripComments(readFileSync(
    join(__dirname, '..', 'app', '[locale]', 'financials', 'sellable-items', 'sellableItemProfile.ts'),
    'utf-8',
  ));

  it.each(LOCALE_CODES)('translates the label and the read-only values in %s.json', (code) => {
    for (const key of KEYS) {
      expect(sellableItemsKey(code, key), `${code}.json is missing sellable_items.${key}`).toBeTypeOf('string');
    }
  });

  it('renders a checkbox, not a dropdown or a text field, in both forms', () => {
    const controls = [...page.matchAll(/checked=\{(inlineNew|editForm)\.mandatory\}/g)].map((m) => m[1]);
    expect(controls).toContain('inlineNew');
    expect(controls).toContain('editForm');
    // Each checked= binding belongs to an <input type="checkbox">.
    expect([...page.matchAll(/type="checkbox"\s*\n\s*checked=\{(inlineNew|editForm)\.mandatory\}/g)]).toHaveLength(2);
    expect(page).not.toMatch(/value=\{(inlineNew|editForm)\.mandatory\}/);
  });

  it('defaults a new item to unchecked and seeds the editor from the stored row', () => {
    expect(page).toContain('mandatory: false, professionalServiceIds: []');
    // #974: the row → form mapping lives beside the field set it fills, so a
    // column added to the card cannot be left out of the form.
    expect(profile).toContain('mandatory: Boolean(item.mandatory)');
  });

  it('submits the flag from the create and the edit payload', () => {
    expect(page).toContain('mandatory: inlineNew.mandatory');
    expect(page).toContain('mandatory: editForm.mandatory');
  });

  // §2: a System item's Mandatory flag is editable, unlike its name/type/units,
  // so the control must not sit inside one of the page's `!isSystem` guards.
  it('offers the checkbox for a System item too', () => {
    const control = page.indexOf('checked={editForm.mandatory}');
    expect(control).toBeGreaterThan(-1);
    const enclosing = page.lastIndexOf('{!isSystem && (', control);
    if (enclosing > -1) {
      // The nearest preceding `!isSystem` block must have closed before the
      // checkbox — otherwise the control is hidden for System items.
      expect(page.slice(enclosing, control)).toContain(')}');
    }
  });

  it('shows the flag on the read-only expanded row and in the Details modal', () => {
    // #974: the expanded card reads the flag through the shared layout's
    // read-only cell, from the same `isMandatory` the list badge uses.
    expect(page).toContain("{isMandatory ? t('yes') : t('no')}");
    expect(page).toContain("value={details.mandatory ? t('yes') : t('no')}");
  });

  it('attaches no Billing Plan behaviour to the flag (out of scope)', () => {
    const plans = readFileSync(join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx'), 'utf-8');
    expect(plans).not.toContain('mandatory');
  });
});
