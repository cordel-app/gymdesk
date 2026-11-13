import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { draftRowCells } from '../components/draftRowCells';

// #2786 — adding the Assigned to column shifted the Products table's draft row:
// its cells were a positional array with no entry for the new column, so every
// cell after Product sat one column to the left of its header.
const TABLE = readFileSync(join(__dirname, '..', 'app', '[locale]', 'members', 'MemberPurchasedProducts.tsx'), 'utf8');

const EXPECTED_ORDER = [
  'product', 'assigned_to', 'date', 'end_date', 'price', 'tax', 'promotion',
  'promotion_benefit', 'discount', 'final', 'payment_status', 'status',
];

describe('#2786 draft row cells follow the columns by key', () => {
  it('places each keyed cell under its own column and leaves the rest empty', () => {
    const columns = [{ key: 'product' }, { key: 'assigned_to' }, { key: 'date' }, {}];
    expect(draftRowCells(columns, { product: 'P', date: 'D' })).toEqual(['P', null, 'D', null]);
  });

  it('yields exactly one cell per column, whatever the draft supplies', () => {
    const columns = EXPECTED_ORDER.map((key) => ({ key }));
    expect(draftRowCells(columns, { product: 'P', extra: 'X' })).toHaveLength(EXPECTED_ORDER.length);
  });
});

describe('#2786 Products table column structure', () => {
  it('declares the twelve data columns in the agreed order, Assigned to between Product and Date', () => {
    const keys = [...TABLE.matchAll(/^\s+key: '([a-z_]+)',$/gm)].map((m) => m[1]);
    expect(keys).toEqual(EXPECTED_ORDER);
  });

  it('builds the draft row from keyed cells, not a positional array', () => {
    expect(TABLE).not.toMatch(/const cells: React\.ReactNode\[\]/);
    expect(TABLE).toContain('const cells: Record<string, React.ReactNode>');
  });
});
