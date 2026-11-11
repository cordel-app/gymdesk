// #2648 stage 5 — every stored VERI*FACTU submission status reads under a label
// that exists in all three locales, with a badge tone of the existing palette.
import { describe, it, expect } from 'vitest';
import en from '../../locales/base/en.json';
import es from '../../locales/base/es.json';
import ca from '../../locales/base/ca.json';
import {
  verifactuBadgeTone, verifactuResponseText, verifactuStatusKey, type VerifactuSubmissionStatus,
} from '../app/[locale]/payments/billing-events/verifactuInvoiceView';

const STATUSES: VerifactuSubmissionStatus[] = [
  'pending', 'sending', 'submitted', 'retry_pending', 'accepted', 'accepted_with_errors', 'rejected',
];

describe('VERI*FACTU invoice view', () => {
  it('labels every status in every locale', () => {
    for (const locale of [en, es, ca] as any[]) {
      for (const s of STATUSES) expect(locale.billing_events_page[verifactuStatusKey(s)]).toBeTruthy();
    }
  });

  it('reads accepted as paid-toned and rejected as failed-toned', () => {
    expect(verifactuBadgeTone('accepted')).toBe('paid');
    expect(verifactuBadgeTone('rejected')).toBe('failed');
    expect(verifactuBadgeTone('retry_pending')).toBe('pending');
  });

  it('spells AEAT\'s last answer, or nothing', () => {
    const base = { aeat_response_code: null, aeat_response_description: null } as any;
    expect(verifactuResponseText(base)).toBeNull();
    expect(verifactuResponseText({ ...base, aeat_response_code: '1100', aeat_response_description: 'Bad NIF' })).toBe('1100: Bad NIF');
  });
});
