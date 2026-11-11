import { describe, it, expect } from 'vitest';
import { normalizePaymentStatus } from '../domain/providerPaymentStatus';

describe('normalizePaymentStatus (#2533)', () => {
  it.each([
    ['SUCCEEDED', 'completed'], ['PAID_OUT', 'completed'], ['PENDING', 'pending'],
    ['PENDING_PROCESSING', 'pending'], ['AUTHORIZED', 'pending'], ['FAILED', 'failed'],
    ['EXPIRED', 'expired'], ['CANCELED', 'canceled'], ['REFUNDED', 'refunded'],
    ['PARTIALLY_REFUNDED', 'partially_refunded'], [' succeeded ', 'completed'],
  ])('%s -> %s', (raw, out) => expect(normalizePaymentStatus(raw)).toBe(out));

  it('never reads an unknown or absent status as failed', () => {
    expect(normalizePaymentStatus('SOMETHING_NEW')).toBeNull();
    expect(normalizePaymentStatus(null)).toBeNull();
  });
});
