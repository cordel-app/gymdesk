import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { newMemberChipStyle, profileInlineCellStyle } from '../app/[locale]/members/MemberProfileLayout';
import { listNameBadgeAccentStyle, listNameBadgeStyle } from '../components/listChrome';

// #3174 (reversing #2807's plain text) — the Profile's `Welcomed` value is a chip in the New
// Member chip's own style, directly below the New Member chip. No component-test infra exists for
// apps/admin, so the structure is asserted on the source.
const layoutSrc = readFileSync(join(__dirname, '../app/[locale]/members/MemberProfileLayout.tsx'), 'utf8');
const rowSrc = readFileSync(join(__dirname, '../app/[locale]/members/MemberExpandedRow.tsx'), 'utf8');
const editSrc = readFileSync(join(__dirname, '../app/[locale]/members/MemberEditForm.tsx'), 'utf8');
const start = layoutSrc.indexOf('export function WelcomedValue');
const welcomedSrc = layoutSrc.slice(start, layoutSrc.indexOf('\n}\n', start));

describe('Members: Welcomed is a chip below New Member (#3174)', () => {
  it('draws the value with the New Member chip style, and its sentence for a screen reader', () => {
    expect(start).toBeGreaterThan(-1);
    expect(welcomedSrc).toContain('newMemberChipStyle(welcomed)');
    expect(welcomedSrc).toContain('aria-label={announce}');
    expect(rowSrc).toContain('welcomed={!!member.welcomed_at}');
  });

  it('stacks the two chips, Welcomed below New Member', () => {
    const cell = rowSrc.slice(rowSrc.indexOf('renderCalculated={() => ('));
    expect(cell.indexOf('<NewMemberValue')).toBeLessThan(cell.indexOf('<WelcomedValue'));
  });

  // #3462 — one label/value grid: labels in the first column, chips in the second, in both halves.
  it('aligns the Welcomed label and chip with New Member in one two-column grid', () => {
    expect(profileInlineCellStyle.display).toBe('grid');
    expect(profileInlineCellStyle.gridTemplateColumns).toBe('max-content max-content');
    expect(layoutSrc).toContain('<div style={profileInlineCellStyle}>');
    // The halves hand the grid its cells directly: a wrapper would collapse them into one cell.
    for (const src of [rowSrc, editSrc]) {
      const cell = src.slice(src.indexOf('renderCalculated={() => ('));
      expect(cell.slice(0, 80)).toContain('<>');
    }
    expect(welcomedSrc).toContain('<span style={profileInlineFieldLabelStyle}>{label}</span>');
    expect(editSrc).toContain("style={profileInlineFieldLabelStyle}>{t('label_welcomed')}</label>");
  });

  it('keeps the chip looks: accent for Yes, neutral for No', () => {
    expect(newMemberChipStyle(true).background).toBe(listNameBadgeAccentStyle.background);
    expect(newMemberChipStyle(true).color).toBe(listNameBadgeAccentStyle.color);
    expect(newMemberChipStyle(false).background).toBe(listNameBadgeStyle.background);
  });
});
