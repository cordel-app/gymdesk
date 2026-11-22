import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { listExpandedStyle } from '../components/listChrome';

// Regression test for #3188 (reopened): the Summary panel was painted with the
// Theme's app background, the very surface the Member's expanded row already
// sits on (`listExpandedStyle`), so it was invisible. No component-test infra
// exists for apps/admin, so the panel's style is read from the source.

const SRC = readFileSync(
  join(__dirname, '..', 'app', '[locale]', 'members', 'CheckoutSummarySections.tsx'),
  'utf8',
);

function panelStyleSource(): string {
  const m = SRC.match(/const panel: CSSProperties = \{([\s\S]*?)\n\};/);
  if (!m) throw new Error('panel style not found');
  return m[1];
}

describe('#3188 Summary panel', () => {
  it('is not drawn on the surface the expanded row already uses', () => {
    const panel = panelStyleSource();
    expect(String(listExpandedStyle.background)).toContain('--gd-app-bg');
    expect(panel).not.toContain('LIST_HEADER_BACKGROUND');
    expect(panel).not.toContain('--gd-app-bg');
  });

  it('takes its colours from the Theme only', () => {
    expect(SRC).toContain('SUMMARY_ACCENT = String(primaryActionColors.background)');
    expect(SRC).toContain("'var(--gd-card-bg, #ffffff)'");
    expect(panelStyleSource()).toMatch(/background: `color-mix\(in srgb, \$\{SUMMARY_ACCENT\}/);
  });

  it('keeps the large headline and the full breakdown below it', () => {
    expect(SRC).toMatch(/data-initial-payment-headline/);
    const panelFn = SRC.slice(SRC.indexOf('export function CheckoutSummaryPanel'));
    expect(panelFn.indexOf('data-initial-payment-headline')).toBeLessThan(panelFn.indexOf('<InitialPaymentSection'));
  });
});
