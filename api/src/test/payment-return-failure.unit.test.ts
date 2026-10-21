// A failed hosted payment sends the member to the error page, not into an
// endless "Payment processing…".
//
// Monei returns the payer to the completeUrl (PAYMENT_OK_URL, the success page)
// whatever the outcome, appending `status=FAILED` on a declined card or a failed
// 3D Secure check. The success page polled for a completed request a failure
// never produces, so the member waited for the timeout with no way to retry.
// In the API suite because CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  isFailedPaymentReturn,
  paymentErrorMessageKey,
  paymentErrorPath,
  paymentRetryPath,
  wantsPaymentRetry,
} from '../../../apps/member/src/lib/paymentReturn';

const MEMBER = join(__dirname, '..', '..', '..', 'apps', 'member');
const read = (p: string) => readFileSync(join(MEMBER, p), 'utf8');

describe('what a return from the hosted payment page means', () => {
  it('treats the provider statuses that move no money as a failure', () => {
    for (const s of ['FAILED', 'failed', 'CANCELED', 'EXPIRED']) expect(isFailedPaymentReturn(s)).toBe(true);
  });

  it('keeps polling for a success, a pending payment or no status at all', () => {
    // The webhook, never the redirect, settles a payment.
    for (const s of ['SUCCEEDED', 'PENDING', 'AUTHORIZED', '', null, undefined]) {
      expect(isFailedPaymentReturn(s)).toBe(false);
    }
  });

  it('sends a failure to the error page, keeping the purpose', () => {
    expect(paymentErrorPath('ca', null)).toBe('/ca/payment/error?reason=failed');
    expect(paymentErrorPath('en', 'card_update')).toBe('/en/payment/error?reason=failed&purpose=card_update');
  });

  it('retries by reopening the payment dialog on My Products', () => {
    expect(paymentRetryPath('es')).toBe('/es/membership?pay=1');
    expect(wantsPaymentRetry('?pay=1')).toBe(true);
    expect(wantsPaymentRetry('?pay=0')).toBe(false);
    expect(wantsPaymentRetry('')).toBe(false);
  });

  it('explains the failure in a localized sentence of its own', () => {
    expect(paymentErrorMessageKey('failed', null)).toBe('payment_error.failed');
    expect(paymentErrorMessageKey('failed', 'card_update')).toBe('payment_error.card_failed');
    expect(paymentErrorMessageKey(null, null)).toBe('payment_error.not_completed');
    for (const locale of ['en', 'es', 'ca']) {
      const messages = JSON.parse(read(`locales/base/${locale}.json`)).payment_error;
      for (const key of ['failed', 'card_failed', 'not_completed']) expect(messages[key], `${locale}.${key}`).toBeTruthy();
    }
  });

  it('wires the success page and the error page to that one module', () => {
    const success = read('src/app/[locale]/payment/success/page.tsx');
    expect(success).toContain('isFailedPaymentReturn(');
    expect(success).toContain('paymentErrorPath(');
    const error = read('src/app/[locale]/payment/error/page.tsx');
    expect(error).toContain('paymentRetryPath(');
    // The provider's message arrives in the URL; showing it would let anyone
    // put their own sentence on the page.
    expect(error).not.toMatch(/get\(['"]message['"]\)/);
  });
});
