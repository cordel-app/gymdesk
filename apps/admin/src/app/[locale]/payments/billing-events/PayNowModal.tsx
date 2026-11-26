'use client';

// #3442 — Pay now on a Billing Event. Opening it reads the eligibility and the
// catalogue methods and writes nothing; choosing a method is page state (#3313's
// `paymentConfirmation`). Only **Pay** sends a request: Members App raises (or
// reuses) a hosted checkout on this same event and shows its link; Cash and the
// external card terminal record a staff-confirmed settlement. **Close** sends
// nothing. A cart cancelled or expired shows the reason and no Pay at all.

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { CrudModal } from '@/components/CrudModal';
import { cardHintStyle, cardSectionLabelStyle, formControlStyle } from '@/components/formChrome';
import { chosenPaymentMethod, paymentActions } from '@/lib/paymentConfirmation';
import { payNowBlockKey, payNowRequest } from './paymentActions';

interface Method { code: string; name: string; available: boolean; reason: string | null }

export function PayNowModal({ billingEventId, memberName, amountLabel, block, onClose, onDone }: {
  billingEventId: number;
  memberName: string;
  amountLabel: string;
  /** The list's `pay_now_block`; the GET re-checks it. */
  block: string | null;
  onClose: () => void;
  /** Something was written: refresh the event. */
  onDone: (outcome: 'paid' | 'checkout') => void;
}) {
  const t = useTranslations('billing_events_page');
  const { apiFetch } = useApiClient();
  const [methods, setMethods] = useState<Method[] | null>(null);
  const [blocked, setBlocked] = useState<string | null>(block);
  const [method, setMethod] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (block) return;
    let cancelled = false;
    apiFetch<{ payment_methods: Method[] }>(`/payments/billing-events/${billingEventId}/pay-now`)
      .then((r) => { if (!cancelled) setMethods(r.payment_methods); })
      .catch((err: any) => {
        if (cancelled) return;
        const code = err?.body?.error;
        if (payNowBlockKey(code)) setBlocked(code);
        else setError(apiErrorMessage(err) ?? t('action_error'));
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingEventId, block]);

  const blockKey = payNowBlockKey(blocked);
  const chosen = chosenPaymentMethod(methods ?? [], method);
  const actions = paymentActions({ chosen, loading: methods == null, busy });

  async function pay() {
    if (inFlight.current || !chosen) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const req = payNowRequest(billingEventId, chosen.code);
      const out = await apiFetch<{ outcome: 'paid' | 'checkout'; checkoutUrl?: string }>(req.path, {
        method: 'POST', body: JSON.stringify(req.body),
      });
      if (out.outcome === 'checkout' && out.checkoutUrl) {
        setCheckoutUrl(out.checkoutUrl);
        onDone('checkout');
      } else {
        onDone('paid');
        onClose();
      }
    } catch (err: any) {
      const code = err?.body?.error;
      if (payNowBlockKey(code)) setBlocked(code);
      else setError(apiErrorMessage(err) ?? t('action_error'));
      // A payment that completed meanwhile: the event is re-read so it shows Paid.
      if (code === 'already_paid') onDone('paid');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const done = blockKey != null || checkoutUrl != null;
  return (
    <CrudModal
      open
      title={t('pay_now_title')}
      error={error}
      saving={busy}
      hideSave={done}
      saveDisabled={!actions.pay}
      saveLabel={t('pay_now_confirm', { amount: amountLabel })}
      cancelLabel={t('modal_close')}
      onCancel={() => { if (actions.cancel) onClose(); }}
      onSave={pay}
    >
      <div data-pay-now>
        <dl style={{ margin: '0 0 14px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 14 }}>
          <dt style={{ color: '#6b7280' }}>{t('modal_member')}</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{memberName}</dd>
          <dt style={{ color: '#6b7280' }}>{t('modal_amount')}</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{amountLabel}</dd>
        </dl>
        {blockKey && <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{t(blockKey)}</p>}
        {!blockKey && checkoutUrl && (
          <>
            <p style={{ margin: '0 0 8px', fontSize: 14 }}>{t('pay_now_link_ready')}</p>
            <input readOnly value={checkoutUrl} aria-label={t('pay_now_link')} style={{ ...formControlStyle, width: '100%' }}
              onFocus={(e) => e.currentTarget.select()} />
          </>
        )}
        {!blockKey && !checkoutUrl && (
          <>
            {methods == null && !error && <p style={cardHintStyle}>{t('pay_now_loading')}</p>}
            {methods && (
              <>
                <div style={cardSectionLabelStyle}>{t('pay_now_method')}</div>
                <select
                  aria-label={t('pay_now_method')}
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  disabled={busy}
                  style={{ ...formControlStyle, maxWidth: 320 }}
                >
                  <option value="">{t('pay_now_method_choose')}</option>
                  {methods.map((m) => (
                    <option key={m.code} value={m.code} disabled={!m.available}>
                      {m.name}{m.available ? '' : ` — ${t('pay_now_method_unavailable')}`}
                    </option>
                  ))}
                </select>
                <p style={{ ...cardHintStyle, marginTop: 8 }}>{t('pay_now_hint')}</p>
              </>
            )}
          </>
        )}
      </div>
    </CrudModal>
  );
}
