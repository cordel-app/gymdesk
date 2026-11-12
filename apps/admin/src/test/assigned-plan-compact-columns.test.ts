import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BENEFIT_ITEM_COLUMN_MIN_WIDTH,
  BENEFIT_ITEM_COMPACT_WIDTH,
  benefitTableMinWidth,
  productBenefitColumns,
} from '@/components/ProductBenefits';

// #2624 stage 1 — the Assigned Plan card's breakdown grid (§6/§7). The Product
// column stops taking every pixel the fixed columns leave over, so the pricing
// and promotion columns share it; names are truncated with their full value in a
// tooltip, and the Promotions touching a line are listed one per line.

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const breakdown = { showFrequency: true, showAction: true, showPrices: true, showBreakdown: true, showMember: true };

describe('#2624 §6: the Product column on the breakdown grid', () => {
  it('is a fixed column there, so the spare width is spread over every column', () => {
    const cols = productBenefitColumns(breakdown);
    expect(cols.find((c) => c.key === 'item')?.width).toBe(BENEFIT_ITEM_COMPACT_WIDTH);
    expect(cols.every((c) => c.width != null)).toBe(true);
  });

  it('keeps the flexible name column everywhere else', () => {
    const plain = productBenefitColumns({ showFrequency: true, showAction: true, showPrices: true });
    expect(plain.find((c) => c.key === 'item')?.width).toBeNull();
  });

  it('still scrolls rather than squashing, at a floor at least the old one', () => {
    const cols = productBenefitColumns(breakdown);
    const fixedRest = cols.filter((c) => c.key !== 'item').reduce((s, c) => s + (c.width ?? 0), 0);
    expect(benefitTableMinWidth(cols)).toBe(fixedRest + BENEFIT_ITEM_COMPACT_WIDTH);
    expect(BENEFIT_ITEM_COMPACT_WIDTH).toBeGreaterThanOrEqual(BENEFIT_ITEM_COLUMN_MIN_WIDTH);
  });
});

describe('#2624 §6/§7: truncation and one value per line', () => {
  const grid = read('components/ProductBenefits.tsx');
  const promotions = read('components/assignedPlan/AssignedPlanPromotions.tsx');

  it('truncates the Product name with its full value as the tooltip', () => {
    expect(grid).toContain('title={nameTitle} style={truncatedInlineSt}');
    expect(grid).toContain("textOverflow: 'ellipsis'");
  });

  it('no longer joins the applied Promotions into one comma-separated string', () => {
    expect(grid).not.toContain("applied_promotions.join(', ')");
    expect(grid).not.toContain("applied_promotion_benefits.join(', ')");
    expect(grid).toContain('<StackedCellValues values={row.applied_promotions} />');
  });

  it('truncates a long Promotion name on its own row, the full name as the tooltip', () => {
    expect(promotions).toContain('title={promotion.promotion_name}');
    expect(promotions).toMatch(/nameBtnSt[^}]*textOverflow: 'ellipsis'/);
  });
});
