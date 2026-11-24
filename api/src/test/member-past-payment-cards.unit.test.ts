/**
 * #3299 — Past Payments draw each payment on the detailed card Next Payment
 * uses (`BillingEventCard`), not the compact row. CI runs `npm test` in `api/`
 * only, so the Members App half is gated from here by reading its sources.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const page = readFileSync(resolve(root, 'apps/member/src/app/[locale]/membership/page.tsx'), 'utf8');
const card = readFileSync(resolve(root, 'apps/member/src/components/MemberPaymentsCard.tsx'), 'utf8');

function fnBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const next = source.indexOf('\n  function ', start + 10);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('#3299 Past Payments use the detailed payment card', () => {
  it('the Past Payments subcard renders each payment through renderPastPaymentCard', () => {
    const tab = fnBody(page, 'renderPaymentsTab');
    const past = tab.slice(tab.indexOf("t('payments.past_heading')"));
    expect(past).toContain('sections.past.map((event) => renderPastPaymentCard(event))');
    expect(past).not.toContain('renderPaymentRow(');
  });

  it('a past payment card carries the same sections Next Payment does, plus its own name, documents and details', () => {
    const body = fnBody(page, 'renderPastPaymentCard');
    expect(body).toContain('<BillingEventCard');
    for (const prop of ['title={paymentTitle(event)}', 'total={money(billingEventAmount(event))}',
      "totalLabel={t('payments.total')}", 'lines={paymentCardLines(event)}', 'paymentStatusPill(event)',
      'paymentChips(event)', 'documents={renderPaymentDocuments(event)}', 'details={paymentDetails(event)}']) {
      expect(body).toContain(prop);
    }
    // Not prominent: Next Payment alone keeps the emphasis.
    expect(body).not.toContain('prominent');
  });

  it('the compact row and the detailed card share one title, chips and details composition', () => {
    const row = fnBody(page, 'renderPaymentRow');
    expect(row).toContain('title={paymentTitle(event)}');
    expect(row).toContain('chips={paymentChips(event)}');
    expect(row).toContain('details={paymentDetails(event)}');
  });

  it('the card draws a missing title, document list or details as nothing, never a placeholder', () => {
    expect(card).toContain('{title && <div style={styles.eventTitle}');
    expect(card).toContain('{documents && <div style={styles.eventDocuments}');
    expect(card).toContain('{details && <div style={styles.eventDetails}');
    // A payment with no method and no notes passes no details at all.
    expect(fnBody(page, 'paymentDetails')).toContain('if (!event.payment_method_name && !notes) return null;');
  });
});
