'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { overlayStyle, modalStyle, primaryBtnStyle } from '@/components/ui';
import { formControlStyle, formFieldLabelStyle, modalActionsRowStyle, secondaryBtnStyle } from '@/components/formChrome';
import { PaymentActionKind, canAccept } from './paymentActions';

/**
 * #1459 — the confirmation for Pay Cash, Pay Card (external terminal) and
 * Waive. It records nothing by itself: only **Accept** calls `onAccept`, and
 * closing it (button, backdrop) calls `onClose` and mutates nothing, so
 * dismissing a payment can never cancel, waive or settle the obligation.
 * Accept is disabled while the request is in flight. The amount arrives
 * already formatted from the Billing Event's own value.
 */
export function PaymentActionModal({
  kind, memberName, amountLabel, busy, error, onAccept, onClose,
}: {
  kind: PaymentActionKind;
  memberName: string;
  amountLabel: string;
  busy: boolean;
  error: string | null;
  onAccept: (input: { reason: string }) => void;
  onClose: () => void;
}) {
  const t = useTranslations('billing_events_page');
  const [reason, setReason] = useState('');
  const dismiss = () => { if (!busy) onClose(); };

  return (
    <div style={overlayStyle} onClick={dismiss}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t(`${kind}_modal_title`)}
        style={{ ...modalStyle, width: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>{t(`${kind}_modal_title`)}</h2>
        <dl style={{ margin: '0 0 14px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 14 }}>
          <dt style={{ color: '#6b7280' }}>{t('modal_member')}</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{memberName}</dd>
          <dt style={{ color: '#6b7280' }}>{t('modal_amount')}</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{amountLabel}</dd>
          <dt style={{ color: '#6b7280' }}>{t('modal_method')}</dt>
          <dd style={{ margin: 0 }}>{t(`${kind}_modal_method`)}</dd>
        </dl>
        <p style={{ margin: '0 0 14px', fontSize: 14, lineHeight: 1.5 }}>
          {t(`${kind}_modal_body`, { amount: amountLabel })}
        </p>

        {kind === 'waive' && (
          <div style={{ marginBottom: 14 }}>
            <label style={formFieldLabelStyle}>{t('waive_reason')}</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('waive_reason_placeholder')}
              maxLength={500}
              rows={3}
              style={{ ...formControlStyle, width: '100%', resize: 'vertical' }}
            />
          </div>
        )}

        {error && <p role="alert" style={{ margin: '0 0 12px', color: '#991b1b', fontSize: 13 }}>{error}</p>}

        <div style={modalActionsRowStyle}>
          <button
            onClick={() => onAccept({ reason })}
            disabled={!canAccept(kind, reason, busy)}
            style={{ ...primaryBtnStyle(), opacity: canAccept(kind, reason, busy) ? 1 : 0.6 }}
          >
            {busy ? t('modal_working') : t('modal_accept')}
          </button>
          <button onClick={dismiss} disabled={busy} style={secondaryBtnStyle}>{t('modal_close')}</button>
        </div>
      </div>
    </div>
  );
}
