import { describe, expect, it } from 'vitest';
import { buildInvoiceKey, buildReceiptKey, invoiceKeyColumn } from '../domain/billingDocumentKeys';
import { getMissingPrivateStorageConfigKeys } from '../infra/private-storage';

describe('billing document keys (#2567)', () => {
  it('builds invoice keys with type and payment state, without the bucket name', () => {
    expect(buildInvoiceKey('g1', 'Cordel Gym!', 7, 'simplified', 'not-paid'))
      .toBe('gyms/g1-CordelGym/invoices/7-simplified-not-paid.pdf');
    expect(buildInvoiceKey('g1', 'Cordel Gym!', 7, 'full', 'paid'))
      .toBe('gyms/g1-CordelGym/invoices/7-full-paid.pdf');
  });
  it('keeps receipts in their own folder', () => {
    expect(buildReceiptKey('g1', 'Cordel Gym', 3)).toBe('gyms/g1-CordelGym/receipts/3.pdf');
  });
  it('maps a representation to its column', () => {
    expect(invoiceKeyColumn('full', 'not-paid')).toBe('full_not_paid_pdf_key');
    expect(invoiceKeyColumn('simplified', 'paid')).toBe('simplified_paid_pdf_key');
  });
  it('names the dedicated private variables when unset', () => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith('CLOUDFLARE_R2_PRIVATE')) delete process.env[k];
    try {
      expect(getMissingPrivateStorageConfigKeys()).toEqual([
        'CLOUDFLARE_R2_PRIVATE_ENDPOINT', 'CLOUDFLARE_R2_PRIVATE_ACCESS_KEY_ID',
        'CLOUDFLARE_R2_PRIVATE_SECRET_ACCESS_KEY', 'CLOUDFLARE_R2_PRIVATE_BUCKET']);
    } finally { Object.assign(process.env, saved); }
  });
});
