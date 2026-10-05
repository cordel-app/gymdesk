import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #788 — the payment return page can tell a replaced card from a paid fee.
// #1117 — My Membership no longer carries a Payment method section.
//
// The Member app has no component-test infra (no testing-library, no jsdom — the
// same note as membership-benefits-snapshot.test.ts), so both pages are pinned
// down by scanning their source.

const SRC = join(__dirname, '..');
const MEMBERSHIP_PAGE = join(SRC, 'app', '[locale]', 'membership', 'page.tsx');
const RETURN_PAGE = join(SRC, 'app', '[locale]', 'payment', 'success', 'page.tsx');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const membershipPage = stripComments(readFileSync(MEMBERSHIP_PAGE, 'utf-8'));
const returnPage = stripComments(readFileSync(RETURN_PAGE, 'utf-8'));

function locale(code: string): any {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

describe('My Membership — no Payment method section (#1117)', () => {
  // Card management belongs to the Payments App; the Members App never offers it.
  it('does not read, replace or remove a stored card', () => {
    expect(membershipPage).not.toContain('/me/payment-method');
    expect(membershipPage).not.toContain('payment_method.');
    expect(membershipPage).not.toContain('replaceCard');
    expect(membershipPage).not.toContain('removeCard');
  });
});

describe('Payment return page — a replaced card is not a payment (#788)', () => {
  it('branches on the purpose the return URL carries', () => {
    expect(returnPage).toContain("useSearchParams().get('purpose') === 'card_update'");
  });

  it('polls the card, not the payment history, for a card update', () => {
    expect(returnPage).toContain("apiFetch<{ last_update: { status: string } | null }>('/me/payment-method')");
    expect(returnPage).toContain("card.last_update?.status === 'completed'");
  });

  it('says no payment was taken', () => {
    expect(returnPage).toContain('payment_success.card_done');
    expect(locale('en').payment_success.card_done.toLowerCase()).toContain('no payment');
  });
});

describe('Translations', () => {
  for (const code of LOCALE_CODES) {
    it(`${code}.json keeps the card-update return-page labels and drops payment_method`, () => {
      const messages = locale(code);
      expect(messages.payment_method).toBeUndefined();
      for (const key of ['card_processing', 'card_done', 'card_timeout']) {
        expect(messages.payment_success?.[key], `${code}: payment_success.${key}`).toBeTruthy();
      }
    });
  }
});
