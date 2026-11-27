'use client';

// #3442 — Pay now on a Billing Event. Opening it reads the eligibility and the
// catalogue methods and writes nothing; choosing a method is page state (#3313's
// `paymentConfirmation`). Only **Pay** sends a request: Members App raises (or
// reuses) a hosted checkout on this same event and shows its link; Cash and the
// external card terminal record a staff-confirmed settlement. **Close** sends
// nothing. A cart cancelled or expired shows the reason and no Pay at all.
//
// #3498 — drawn by the shared `PaymentModal` Save & Pay also uses: the amount
// large at the top right (the event's own, from the read) and the event's
// persisted lines listed automatically. Pay re-reads both first and refuses to
// collect when either moved since it was shown.

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { PaymentItemsTable, PaymentMethodSelect, PaymentModal } from '@/components/PaymentModal';
import { cardHintStyle, formControlStyle } from '@/components/formChrome';
import { chosenPaymentMethod, paymentActions } from '@/lib/paymentConfirmation';
import { billingEventPaymentItems, paymentModalAmountLabel, paymentModalUnchanged, type PaymentModalItem } from '@/lib/paymentModal';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { payNowBlockKey, payNowRequest } from './paymentActions';

interface Method { code: string; name: string; available: boolean; reason: string | null }
interface PayNowRead {
  amount: string;
  payment_methods: Method[];
  lines?: Array<{ id: number; item_name: string | null; quantity: number; amount: string | number }>;
}

export function PayNowModal({ billingEventId, memberName, amount, block, onClose, onDone }: {
  billingEventId: number;
  memberName: string;
  /** The list's amount, shown until the read answers with the authoritative one. */
  amount: string | number | null;
  /** The list's `pay_now_block`; the GET re-checks it. */
  block: string | null;
  onClose: () => void;
  /** Something was written: refresh the event. */
  onDone: (outcome: 'paid' | 'checkout') => void;
}) {
  const t = useTranslations('billing_events_page');
  const { apiFetch } = useApiClient();
  const fmt = useGymFormatSettings();
  const [methods, setMethods] = useState<Method[] | null>(null);
  const [shown, setShown] = useState<{ amount: string | number | null; items: PaymentModalItem[] } | null>(null);
  const [blocked, setBlocked] = useState<string | null>(block);
  const [method, setMethod] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (block) return;
    let cancelled = false;
    apiFetch<PayNowRead>(`/payments/billing-events/${billingEventId}/pay-now`)
      .then((r) => {
        if (cancelled) return;
        setMethods(r.payment_methods);
        setShown({ amount: r.amount, items: billingEventPaymentItems(r.lines) });
      })
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
      // Revalidate before collecting: what is paid is what the modal showed.
      const fresh = await apiFetch<PayNowRead>(`/payments/billing-events/${billingEventId}/pay-now`);
      const freshShown = { amount: fresh.amount, items: billingEventPaymentItems(fresh.lines) };
      if (!shown || !paymentModalUnchanged(shown, freshShown)) {
        setShown(freshShown);
        setMethods(fresh.payment_methods);
        setError(t('pay_now_changed'));
        return;
      }
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
  const headline = shown?.amount ?? amount;
  return (
    <PaymentModal
      title={t('pay_now_title')}
      amount={headline}
      amountLabel={t('modal_amount')}
      itemsLabel={t('pay_now_items')}
      items={shown == null
        ? <p style={cardHintStyle}>{t('pay_now_loading')}</p>
        : <PaymentItemsTable items={shown.items} itemHeader={t('pay_now_col_item')} amountHeader={t('pay_now_col_amount')} emptyLabel={t('pay_now_items_empty')} />}
      error={error}
      saving={busy}
      hideSave={done}
      saveDisabled={!actions.pay}
      saveLabel={t('pay_now_confirm', { amount: paymentModalAmountLabel(headline, fmt) })}
      cancelLabel={t('modal_close')}
      onCancel={() => { if (actions.cancel) onClose(); }}
      onSave={pay}
    >
      <div data-pay-now>
        <dl style={{ margin: '0 0 14px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 14 }}>
          <dt style={{ color: 'var(--gd-text-secondary, #6b7280)' }}>{t('modal_member')}</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{memberName}</dd>
        </dl>
        {blockKey && <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{t(blockKey)}</p>}
        {!blockKey && checkoutUrl && (
          <>
            <p style={{ margin: '0 0 8px', fontSize: 14 }}>{t('pay_now_link_ready')}</p>
            <input readOnly value={checkoutUrl} aria-label={t('pay_now_link')} style={{ ...formControlStyle, width: '100%' }}
              onFocus={(e) => e.currentTarget.select()} />
          </>
        )}
        {!blockKey && !checkoutUrl && methods && (
          <PaymentMethodSelect
            label={t('pay_now_method')}
            chooseLabel={t('pay_now_method_choose')}
            methods={methods}
            value={method}
            onChange={setMethod}
            disabled={busy}
            unavailableText={() => t('pay_now_method_unavailable')}
            hint={<p style={{ ...cardHintStyle, marginTop: 8 }}>{t('pay_now_hint')}</p>}
          />
        )}
      </div>
    </PaymentModal>
  );
}
