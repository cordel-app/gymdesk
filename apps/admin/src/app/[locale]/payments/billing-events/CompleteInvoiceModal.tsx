'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { overlayStyle, modalStyle, primaryBtnStyle } from '@/components/ui';
import {
  formControlStyle, formErrorStyle, formFieldLabelStyle, modalActionsRowStyle, secondaryBtnStyle,
} from '@/components/formChrome';
import { fullInvoiceFormError, type FullInvoiceForm } from './receiptsInvoicesView';

/**
 * #2648 stage 6 — *Generate Complete Invoice* from a Billing Event's ⋮ menu.
 * Collects the customer's fiscal details and hands them to `onSubmit`, which
 * calls the existing `POST /payments/billing-events/:id/invoices`. Closing it
 * issues nothing.
 */
export function CompleteInvoiceModal({
  billingEventId, memberName, busy, error, onSubmit, onClose,
}: {
  billingEventId: number;
  memberName: string;
  busy: boolean;
  error: string | null;
  onSubmit: (form: FullInvoiceForm) => void;
  onClose: () => void;
}) {
  const t = useTranslations('billing_events_page');
  const [form, setForm] = useState<FullInvoiceForm>({ customer_name: memberName, customer_tax_id: '', customer_address: '' });
  const [localError, setLocalError] = useState<string | null>(null);
  const dismiss = () => { if (!busy) onClose(); };

  function submit() {
    const key = fullInvoiceFormError(form);
    if (key) { setLocalError(t(key as any)); return; }
    setLocalError(null);
    onSubmit({
      customer_name: form.customer_name.trim(),
      customer_tax_id: form.customer_tax_id.trim(),
      customer_address: form.customer_address.trim(),
    });
  }

  const shown = localError ?? error;
  return (
    <div style={overlayStyle} onClick={dismiss}>
      <div role="dialog" aria-modal="true" aria-label={t('generate_full_invoice')}
        style={{ ...modalStyle, width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>{t('generate_full_invoice')}</h2>
        <p style={{ margin: '0 0 12px', fontSize: 14 }}>{t('full_inv_explain')}</p>
        {([
          ['customer_name', 'full_inv_name', 255],
          ['customer_tax_id', 'full_inv_tax_id', 50],
        ] as const).map(([field, label, max]) => (
          <div key={field} style={{ marginBottom: 10 }}>
            <label style={formFieldLabelStyle} htmlFor={`full-inv-${field}-${billingEventId}`}>{t(label)}</label>
            <input id={`full-inv-${field}-${billingEventId}`} type="text" maxLength={max} value={form[field]}
              onChange={(e) => setForm({ ...form, [field]: e.target.value })} style={formControlStyle} />
          </div>
        ))}
        <label style={formFieldLabelStyle} htmlFor={`full-inv-address-${billingEventId}`}>{t('full_inv_address')}</label>
        <textarea id={`full-inv-address-${billingEventId}`} rows={2} maxLength={2000} value={form.customer_address}
          onChange={(e) => setForm({ ...form, customer_address: e.target.value })} style={formControlStyle} />
        {shown && <div role="alert" style={formErrorStyle}>{shown}</div>}
        <div style={modalActionsRowStyle}>
          <button type="button" onClick={submit} disabled={busy} style={{ ...primaryBtnStyle(), opacity: busy ? 0.6 : 1 }}>
            {busy ? t('doc_generating') : t('generate_full_invoice')}
          </button>
          <button type="button" onClick={dismiss} disabled={busy} style={secondaryBtnStyle}>{t('full_inv_cancel')}</button>
        </div>
      </div>
    </div>
  );
}
