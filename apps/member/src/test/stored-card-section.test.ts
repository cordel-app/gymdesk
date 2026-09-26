import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #788 — My Membership carries a Payment method section, and the payment return
// page can tell a replaced card from a paid fee.
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

describe('My Membership — Payment method section (#788)', () => {
  it('reads the card from the API rather than the payment history', () => {
    expect(membershipPage).toContain("apiFetch<PaymentMethodState>('/me/payment-method')");
    expect(membershipPage).toContain("t('payment_method.heading')");
  });

  it('offers Replace card through the verification route, not a payment', () => {
    expect(membershipPage).toContain("'/me/payment-method/replace-requests'");
    // The old way to store a card was to raise a full membership fee, which is
    // the defect this ticket removed — the replace action must never go there.
    expect(membershipPage).not.toMatch(/replaceCard[\s\S]{0,400}\/me\/payment-requests/);
  });

  it('shows Remove card only when the server says it is allowed', () => {
    expect(membershipPage).toContain('card.can_remove');
    expect(membershipPage).toContain("t('payment_method.remove_blocked')");
    // The decision is the API's (`cardRemovalBlock()`); the page must not
    // re-derive it from the membership it happens to be rendering.
    expect(membershipPage).not.toMatch(/can_remove\s*=\s*membership/);
  });

  it('never renders the token that charges the card', () => {
    expect(membershipPage).not.toContain('payment_token');
    expect(membershipPage).not.toContain('sequence_id');
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
  const KEYS = [
    'heading', 'card', 'none', 'since', 'add', 'replace', 'remove',
    'remove_confirm', 'remove_blocked', 'rate_limited',
  ];

  // next-intl has no locale fallback here, so a key missing from es/ca renders
  // as its raw dotted path.
  for (const code of LOCALE_CODES) {
    it(`${code}.json carries every payment_method label and the card variants`, () => {
      const messages = locale(code);
      for (const key of KEYS) {
        expect(messages.payment_method?.[key], `${code}: payment_method.${key}`).toBeTruthy();
      }
      for (const key of ['card_processing', 'card_done', 'card_timeout']) {
        expect(messages.payment_success?.[key], `${code}: payment_success.${key}`).toBeTruthy();
      }
    });
  }
});
