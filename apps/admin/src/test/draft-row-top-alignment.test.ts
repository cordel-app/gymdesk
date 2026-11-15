import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #2855 — the Products table's draft row aligns its cells with the Product
// dropdown at the top of the identity cell, not with the whole cell (the
// Promotions sit underneath the dropdown). apps/admin has no component-test
// infra, so this pins the wiring by source scan.
const table = readFileSync(join(__dirname, '..', 'components', 'DataTable.tsx'), 'utf8');

describe('#2855 draft row top alignment', () => {
  const draft = table.slice(table.indexOf('data-draft-row'), table.indexOf('{rows.map('));

  it('top-aligns every draft cell', () => {
    expect(table).toMatch(/const draftTd: React\.CSSProperties = \{ \.\.\.listCellStyle, verticalAlign: 'top' \}/);
    expect(draft).not.toContain('style={td}');
    expect(draft).toContain('style={draftTd}');
  });

  it('puts every other cell on one control-high line', () => {
    expect(draft).toContain('<div style={draftCellLineStyle}>{cells[i]}</div>');
    expect(table).toMatch(/draftCellLineStyle[^=]*= \{ minHeight: 36, display: 'flex', alignItems: 'center' \}/);
  });

  it('keeps the promotions inside the Product cell, under the dropdown', () => {
    const form = readFileSync(join(__dirname, '..', 'app', '[locale]', 'members', 'AddProductPurchase.tsx'), 'utf8');
    const cell = form.slice(form.indexOf('data-product-cell'));
    expect(cell.indexOf('</select>')).toBeLessThan(cell.indexOf('{productPromotionsCell(f)}'));
  });
});
