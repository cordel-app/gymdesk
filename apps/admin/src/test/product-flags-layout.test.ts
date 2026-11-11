import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT_SECTIONS } from '../app/[locale]/financials/products/productProfile';
import { productFlagRowStyle } from '../app/[locale]/financials/products/ProductFlagRow';

/**
 * #2623: Mandatory, One-time Purchase and One per Member are each one row —
 * label left, toggle right — and Sharing Type sits directly under them, in
 * both Gym Products and Base Products, through the one shared `ProductFlagRow`.
 */
const APP = join(__dirname, '..', 'app', '[locale]');
const PAGES = {
  gym: join(APP, 'financials', 'products', 'page.tsx'),
  base: join(APP, 'cordel', 'base-products', 'page.tsx'),
};

function flagOrder(src: string, from: number): string[] {
  const re = /<ProductFlagRow label=\{tp?\('(\w+)'\)\}|<label style=\{formFieldLabelStyle\}>\{t\('sharing_type'\)\}/g;
  re.lastIndex = from;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) && out.length < 4) out.push(m[1] ?? 'sharing_type');
  return out;
}

describe('Product settings layout (#2623)', () => {
  it('draws a flag row with the label and the control on one line, toggles right-aligned', () => {
    expect(productFlagRowStyle.display).toBe('flex');
    expect(productFlagRowStyle.alignItems).toBe('center');
    expect(productFlagRowStyle.justifyContent).toBe('space-between');
    // Wraps on a narrow screen rather than overlapping.
    expect(productFlagRowStyle.flexWrap).toBe('wrap');
  });

  it.each(Object.entries(PAGES))('orders the %s settings Mandatory, One-time Purchase, One per Member, Sharing Type in both modes', (_name, path) => {
    const src = readFileSync(path, 'utf-8');
    const starts = [...src.matchAll(/<ProductFlagRow label=\{tp?\('label_mandatory'\)\}/g)].map((m) => m.index!);
    expect(starts.length).toBeGreaterThan(0);
    for (const at of starts) {
      const order = flagOrder(src, at);
      // The create form carries Mandatory alone; every full group is in this order.
      if (order[1] === 'one_time_purchase') {
        expect(order).toEqual(['label_mandatory', 'one_time_purchase', 'one_per_member', 'sharing_type']);
      }
    }
    expect(src).not.toMatch(/<ProductFlagRow label=\{t\('sharing_type'\)\}/);
  });

  it('labels the Mandatory group inline, not again above the cell', () => {
    const mandatory = PRODUCT_SECTIONS.flatMap((s) => s.fields).find((f) => f.key === 'mandatory')!;
    expect(mandatory.labelKey).toBeUndefined();
    expect(mandatory.fullWidth).toBe(true);
  });
});
