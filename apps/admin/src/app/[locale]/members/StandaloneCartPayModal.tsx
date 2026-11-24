'use client';

// #3313 — the payment step of a standalone cart's Save & Pay (a cart of one-time Products no Draft
// Product Set carries). Opening it and choosing **Members App** write nothing: no Billing Event, no
// payment request, no change to the cart. Only **Pay** sends `POST …/product-purchases/checkout`,
// after re-reading the cart Summary so the amount and purchases paid are the server's current ones;
// **Cancel** closes it and sends nothing. A second click while Pay is in flight never reaches the
// server, and the server refuses a second checkout of the same purchases anyway.

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { CrudModal } from '@/components/CrudModal';
import { cardHintStyle, cardSectionLabelStyle, formControlStyle } from '@/components/formChrome';
import {
  STANDALONE_CART_PAYMENT_METHODS, chosenPaymentMethod, paymentActions,
} from '@/lib/paymentConfirmation';

interface CartSummary {
  purchase_ids: number[];
  amount_due: number;
  currency: string;
}

const money = (n: number, currency = 'EUR') => (currency === 'EUR' ? `${n.toFixed(2)}€` : `${n.toFixed(2)} ${currency}`);

export function StandaloneCartPayModal({ memberId, open, onClose, onPaid }: {
  memberId: number;
  open: boolean;
  onClose: () => void;
  /** The checkout was created: its link, to show and copy. */
  onPaid: (checkoutUrl: string) => void;
}) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const [summary, setSummary] = useState<CartSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState('');
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSummary(null); setError(null); setMethod(''); setLoading(true);
    apiFetch<CartSummary>(`/members/${memberId}/product-purchases/cart-summary`)
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch((err) => { if (!cancelled) setError(apiErrorMessage(err) ?? t('review_error_generic')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, memberId]);

  const chosen = chosenPaymentMethod(STANDALONE_CART_PAYMENT_METHODS, method);
  const actions = paymentActions({ chosen, loading: loading || summary == null || summary.amount_due <= 0, busy });

  async function pay() {
    if (inFlight.current || !chosen || !summary) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // The amount paid is the server's at the moment Pay is confirmed.
      const fresh = await apiFetch<CartSummary>(`/members/${memberId}/product-purchases/cart-summary`);
      if (fresh.amount_due !== summary.amount_due) {
        setSummary(fresh);
        setError(t('review_error_changed'));
        return;
      }
      const out = await apiFetch<{ checkoutUrl: string }>(`/members/${memberId}/product-purchases/checkout`, {
        method: 'POST', body: JSON.stringify({ purchase_ids: fresh.purchase_ids }),
      });
      onPaid(out.checkoutUrl);
    } catch (err: any) {
      setError(apiErrorMessage(err) ?? t('review_error_generic'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const amount = summary ? money(summary.amount_due, summary.currency) : '';
  return (
    <CrudModal
      open={open}
      title={t('cart_pay_title')}
      error={error}
      saving={busy}
      saveDisabled={!actions.pay}
      cancelLabel={t('cancel')}
      saveLabel={chosen ? t('pay_action_members_app', { amount }) : t('review_confirm_pay', { amount })}
      onCancel={() => { if (actions.cancel) onClose(); }}
      onSave={pay}
    >
      <div data-standalone-cart-pay>
        {loading && <p style={cardHintStyle}>{t('review_loading')}</p>}
        {summary && (
          <>
            <div style={cardSectionLabelStyle}>{t('review_initial_payment')}</div>
            <p style={{ margin: '4px 0 12px', fontSize: 14 }}>{amount}</p>
            <div style={cardSectionLabelStyle}>{t('pay_method')}</div>
            <select
              aria-label={t('pay_method')}
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              disabled={busy}
              style={{ ...formControlStyle, maxWidth: 320 }}
            >
              <option value="">{t('pay_method_choose')}</option>
              {STANDALONE_CART_PAYMENT_METHODS.map((m) => (
                <option key={m.code} value={m.code}>{t('cart_pay_method_members_app')}</option>
              ))}
            </select>
          </>
        )}
      </div>
    </CrudModal>
  );
}
