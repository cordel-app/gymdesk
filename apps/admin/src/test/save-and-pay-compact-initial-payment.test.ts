import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { compactInitialPaymentLabel } from '../app/[locale]/members/productsWorkflowView';

// #3285 — the Save & Pay confirmation shows the Initial Payment as a compact Item / Amount list.
// No component-test infra exists for apps/admin, so the rendering is read from the source.

const DIR = join(__dirname, '..', 'app', '[locale]', 'members');
const SECTIONS = readFileSync(join(DIR, 'CheckoutSummarySections.tsx'), 'utf8');
const MODAL = readFileSync(join(DIR, 'ReviewChangesModal.tsx'), 'utf8');

function compactBranch(): string {
  const start = SECTIONS.indexOf('if (compact) {');
  const end = SECTIONS.indexOf('  return (\n    <div data-initial-payment style', start);
  if (start < 0 || end < 0) throw new Error('compact branch not found');
  return SECTIONS.slice(start, end);
}

describe('#3285 compact line label', () => {
  it('appends the quantity only when more than one unit is charged', () => {
    expect(compactInitialPaymentLabel({ name: 'Locker Rental', quantity: 5 })).toBe('Locker Rental × 5');
    expect(compactInitialPaymentLabel({ name: 'Insurance Fee', quantity: 1 })).toBe('Insurance Fee');
    expect(compactInitialPaymentLabel({ name: null, quantity: 1 })).toBe('—');
  });
});

describe('#3285 Save & Pay compact Initial Payment', () => {
  it('the modal asks for the compact view, the Summary keeps the full one', () => {
    expect(MODAL).toMatch(/<InitialPaymentSection payment=\{review\.initial_payment\} compact \/>/);
    const panel = SECTIONS.slice(SECTIONS.indexOf('export function CheckoutSummaryPanel'));
    expect(panel).toMatch(/<InitialPaymentSection payment=\{payment\} \/>/);
  });

  it('shows exactly Item and Amount (incl. VAT), from each line’s server amount', () => {
    const branch = compactBranch();
    expect(branch.match(/<th /g)).toHaveLength(2);
    expect(branch).toContain("t('checkout_col_item')");
    expect(branch).toContain("t('checkout_col_amount')");
    expect(branch).toContain('money(l.amount)');
    // every line is drawn, a zero (waived) one included, in the server's order
    expect(branch).toContain('payment.lines.map(');
    expect(branch).not.toMatch(/\.filter\(/);
    for (const hidden of ['unit_price', 'line_total', 'tax_rate_percent', 'tax_amount', 'discountText', 'proration', 'fee_split', 'prepaid', 'source']) {
      expect(branch).not.toContain(hidden);
    }
  });

  it('keeps the totals summary under the compact list and needs no horizontal scroll', () => {
    const branch = compactBranch();
    expect(branch).toContain('{totalsBlock}');
    expect(branch).not.toContain('overflowX');
    expect(SECTIONS).toContain("<TotalRow strong label={t('checkout_total_initial_payment')} value={money(payment.total)} />");
  });

  it('keeps the payment method selector and the forecast in the modal', () => {
    expect(MODAL).toContain("t('pay_method')");
    expect(MODAL).toContain('<ProductSetForecast');
    expect(MODAL.indexOf('<InitialPaymentSection')).toBeLessThan(MODAL.indexOf('<ProductSetForecast'));
  });
});
