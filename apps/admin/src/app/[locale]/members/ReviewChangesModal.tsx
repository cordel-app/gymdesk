'use client';

// #1537 — **Review your changes**: the differences between the Active
// configuration and the Draft, what is due today and what recurs after it, and
// the one global Save & Pay.
//
// It decides nothing a rule owns. The diff and the amount are
// `GET /product-sets/:id/review` (the amount from the very function Save & Pay
// charges from), and it is re-asked when the user confirms, so a stale figure
// can never be paid. Closing the modal discards nothing: the Draft stays.

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { CrudModal } from '@/components/CrudModal';
import { cardHintStyle, cardSectionLabelStyle, formControlStyle } from '@/components/formChrome';
import type { BillingEventSimulationData } from '@/components/BillingEventSimulation';
import { ProductSetForecast } from './MemberProductSet';
import { changeMessage, confirmAction, type ChangeLike, type ReviewLike } from './recurringProductsView';

interface Review extends ReviewLike {
  product_set_id: number;
  status: string;
  has_previous: boolean;
  changes: ChangeLike[];
  immediate_lines: Array<{
    item_name: string | null; quantity: number; amount: number;
    regular_unit_price?: number | null; promotion_name?: string | null;
    tax_rate_percent?: number | null; amount_excl_tax?: number | null;
  }>;
  currency: string;
  /** #1664 — the active Base Payment Methods and whether each can be used for this member. */
  payment_methods?: Array<{ code: string; name: string; available: boolean; reason: string | null }>;
  net_total?: number;
  tax_total?: number | null;
}

const money = (n: number, currency = 'EUR') => (currency === 'EUR' ? `${n.toFixed(2)}€` : `${n.toFixed(2)} ${currency}`);

export function ReviewChangesModal({
  productSetId, open, onClose, onCommitted,
}: {
  productSetId: number;
  open: boolean;
  onClose: () => void;
  /** The version was activated or saved for payment: re-read the section. `checkoutUrl` is set while a payment is awaited. */
  onCommitted: (result: { activated: boolean; checkoutUrl: string | null }) => void;
}) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const [review, setReview] = useState<Review | null>(null);
  const [forecast, setForecast] = useState<BillingEventSimulationData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<string>('');
  const [notice, setNotice] = useState<string | null>(null);
  // A second click while the first is in flight must not reach the server.
  const inFlight = useRef(false);

  function describe(err: any): string {
    const code = err?.body?.error ?? err?.message;
    if (code === 'draft_expired') return t('review_error_expired');
    if (code === 'monei_token_missing') return t('pay_monei_no_token');
    if (code === 'edit_locked') return t('review_error_locked');
    return apiErrorMessage(err) ?? t('review_error_generic');
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setReview(null); setForecast(null); setError(null); setNotice(null); setMethod(''); setLoading(true);
    Promise.all([
      apiFetch<Review>(`/product-sets/${productSetId}/review`),
      apiFetch<BillingEventSimulationData>(`/product-sets/${productSetId}/billing-event-simulation`).catch(() => null),
    ])
      .then(([r, f]) => { if (!cancelled) { setReview(r); setForecast(f); } })
      .catch((err) => { if (!cancelled) setError(describe(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, productSetId]);

  const action = confirmAction(review);
  const owes = action?.key === 'review_confirm_pay';
  const methods = review?.payment_methods ?? [];
  const chosen = methods.find((m) => m.code === method && m.available) ?? null;
  const saveLabel = action == null
    ? t('review_confirm')
    : owes
      ? (chosen ? t(`pay_action_${chosen.code}` as any, { amount: money(action.amount ?? 0, review?.currency) }) : t('review_confirm_pay', { amount: money(action.amount ?? 0, review?.currency) }))
      : t('review_confirm');

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // Revalidate and recalculate at the moment of confirmation.
      const fresh = await apiFetch<Review>(`/product-sets/${productSetId}/review`);
      setReview(fresh);
      const next = confirmAction(fresh);
      if (!next) { setError(t('review_error_amount')); return; }
      if (next.amount !== (confirmAction(review)?.amount ?? null)) {
        // The amount moved since it was shown: the user confirms the new one.
        setError(t('review_error_changed'));
        return;
      }
      try {
        if (!chosen) { setError(t('pay_error_method_required')); return; }
        const res = await apiFetch<{ checkout_url?: string | null; outcome?: string }>(`/product-sets/${productSetId}/pay`, {
          method: 'POST', body: JSON.stringify({ method: chosen.code }),
        });
        if (res.outcome === 'failed') { setNotice(null); setError(t('pay_outcome_failed')); onCommitted({ activated: false, checkoutUrl: null }); return; }
        if (res.outcome === 'pending' || res.outcome === 'unknown') { setNotice(t(res.outcome === 'pending' ? 'pay_outcome_pending' : 'pay_outcome_unknown')); onCommitted({ activated: false, checkoutUrl: null }); return; }
        onCommitted({ activated: res.outcome === 'paid', checkoutUrl: res.checkout_url ?? null });
      } catch (err: any) {
        if ((err?.body?.error ?? err?.message) === 'nothing_to_pay') {
          await apiFetch(`/product-sets/${productSetId}/activate`, { method: 'POST', body: JSON.stringify({}) });
          onCommitted({ activated: true, checkoutUrl: null });
        } else {
          throw err;
        }
      }
    } catch (err: any) {
      setError(describe(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <CrudModal
      open={open}
      title={t('review_title')}
      error={error ?? notice}
      saving={busy}
      saveDisabled={loading || busy || action == null || (owes && !chosen)}
      cancelLabel={t('close')}
      saveLabel={saveLabel}
      onCancel={onClose}
      onSave={confirm}
    >
      {loading && <p style={cardHintStyle}>{t('review_loading')}</p>}
      {review && (
        <div data-review-changes>
          <div style={cardSectionLabelStyle}>{t('review_changes')}</div>
          {review.changes.length === 0 ? (
            <p style={cardHintStyle}>{t('review_no_changes')}</p>
          ) : (
            <ul style={{ margin: '4px 0 12px', paddingLeft: 18, fontSize: 14 }}>
              {review.changes.map((c, i) => {
                const m = changeMessage(c);
                return <li key={i}>{t(m.key as any, m.values as any)}</li>;
              })}
            </ul>
          )}

          <div style={cardSectionLabelStyle}>{t('review_due_today')}</div>
          {review.amount_due == null ? (
            <p style={cardHintStyle}>{t('review_error_amount')}</p>
          ) : (
            <>
              {review.immediate_lines.map((l, i) => (
                <div key={i} style={{ fontSize: 14, marginBottom: 4 }}>
                  <div>
                    {l.item_name ?? '—'} × {l.quantity}: {money(l.amount, review.currency)}
                  </div>
                  <div style={{ ...cardHintStyle, margin: 0 }}>
                    {l.regular_unit_price != null ? `${t('pay_original_price')}: ${money(l.regular_unit_price * l.quantity, review.currency)}` : ''}
                    {l.promotion_name ? ` · ${t('pay_promotion')}: ${l.promotion_name}` : ''}
                    {l.tax_rate_percent != null && l.amount_excl_tax != null
                      ? ` · ${t('pay_vat_line', { rate: l.tax_rate_percent, net: money(l.amount_excl_tax, review.currency), tax: money(l.amount - l.amount_excl_tax, review.currency) })}`
                      : ''}
                  </div>
                </div>
              ))}
              {review.amount_due > 0 && review.tax_total != null && (
                <div style={{ fontSize: 13 }}>
                  {t('pay_net_total')}: {money(review.net_total ?? 0, review.currency)} · {t('pay_tax_total')}: {money(review.tax_total, review.currency)}
                </div>
              )}
              <div style={{ fontWeight: 600, fontSize: 14, margin: '4px 0 12px' }}>
                {review.amount_due > 0 ? `${t('pay_total_incl_vat')}: ${money(review.amount_due, review.currency)}` : t('review_nothing_due')}
              </div>
              {owes && (
                <div style={{ marginBottom: 12 }}>
                  <div style={cardSectionLabelStyle}>{t('pay_method')}</div>
                  <select
                    aria-label={t('pay_method')}
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    disabled={busy}
                    style={{ ...formControlStyle, maxWidth: 320 }}
                  >
                    <option value="">{t('pay_method_choose')}</option>
                    {methods.map((m) => (
                      <option key={m.code} value={m.code} disabled={!m.available} style={m.available ? undefined : { opacity: 0.5 }}>
                        {m.name}{m.available ? '' : ` — ${m.reason === 'monei_token_missing' ? t('pay_monei_no_token') : t('pay_method_unavailable')}`}
                      </option>
                    ))}
                  </select>
                  {methods.some((m) => m.code === 'monei' && m.reason === 'monei_token_missing') && (
                    <p style={cardHintStyle}>{t('pay_monei_no_token')}</p>
                  )}
                </div>
              )}
            </>
          )}

          <div style={cardSectionLabelStyle}>{t('review_future')}</div>
          <p style={cardHintStyle}>{t('review_future_hint')}</p>
          <ProductSetForecast forecast={forecast} loading={false} error={forecast == null} />
        </div>
      )}
    </CrudModal>
  );
}
