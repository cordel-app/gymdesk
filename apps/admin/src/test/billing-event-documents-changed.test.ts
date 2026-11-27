// #2885 — issuing a receipt or complete invoice refreshes that Billing Event's
// Receipts & Invoices table: the signal reaches the subscriber of that event
// only, and an unsubscribed listener hears nothing.
import { describe, it, expect, vi } from 'vitest';
import {
  notifyBillingEventDocumentsChanged, subscribeBillingEventDocumentsChanged,
} from '../app/[locale]/payments/billing-events/documentsChanged';

describe('billing event documents-changed signal', () => {
  it('reaches the subscriber of the issued event only', () => {
    const target = new EventTarget();
    const a = vi.fn();
    const b = vi.fn();
    subscribeBillingEventDocumentsChanged(7, a, target);
    subscribeBillingEventDocumentsChanged(8, b, target);
    notifyBillingEventDocumentsChanged(7, target);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('stops after unsubscribing', () => {
    const target = new EventTarget();
    const a = vi.fn();
    const off = subscribeBillingEventDocumentsChanged(7, a, target);
    off();
    notifyBillingEventDocumentsChanged(7, target);
    expect(a).not.toHaveBeenCalled();
  });

  it('is announced by the ⋮ complete-invoice action after success only (#3548: receipts are the system\'s)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../app/[locale]/payments/billing-events/BillingEventShared.tsx', import.meta.url), 'utf8');
    const notify = src.split('notifyBillingEventDocumentsChanged(id)').length - 1;
    expect(notify).toBe(1);
    // each call sits inside a try block, before its catch
    for (const fn of ['async function submitCompleteInvoice']) {
      const body = src.slice(src.indexOf(fn), src.indexOf('} catch', src.indexOf(fn)));
      expect(body).toContain('notifyBillingEventDocumentsChanged(id)');
    }
  });
});
