'use client';

// #1325 PR 3b — the Member's ProductSet versions still in flight: a plan saved
// and awaiting its first payment, or a Draft not yet committed.
//
// They have no assignment until activation (that is what the projection writes),
// so the MEMBERSHIP PLANS section lists them here and acts on them only through
// `/product-sets`; every transition is the server's. Nothing here prices, decides
// whether something is owed or confirms a replacement.

import React, { useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { cardHintStyle, cardSubLabelStyle, formErrorStyle, secondaryBtnSmall } from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import type { ProductSetRow } from './membershipConfiguration';
import { changeMessage, type ChangeLike } from './recurringProductsView';
import type { FinancialSummaryLike, SummaryItemLike } from './productsWorkflowView';

interface Props {
  productSets: ProductSetRow[];
  canWrite: boolean;
  /** The Draft's review diff (#1660): what the Summary lists as added / removed. */
  changes?: unknown[];
  /** #2446 — every item of the pending set with its economic conditions. */
  items?: SummaryItemLike[];
  /** #2446 stage 3 — the totals of the pending set, the server's. */
  financial?: FinancialSummaryLike | null;
  /** Re-reads the Member's configuration after an action. */
  onChanged: () => void;
}

export function ProductSetsInFlight({ productSets, canWrite, changes = [], items = [], financial = null, onChanged }: Props) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [link, setLink] = useState<{ id: number; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inFlight = productSets.filter((p) => p.status === 'draft' || p.status === 'pending_payment');
  if (inFlight.length === 0) return null;

  async function run(id: number, action: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err: any) {
      setError(apiErrorMessage(err) ?? t('error_generic'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      {inFlight.map((ps) => (
        <div key={ps.id} style={row} data-product-set-id={ps.id}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{ps.plan_name ?? t('product_set_no_plan')}</strong>
            <span style={cardHintStyle}>
              {' · '}
              {ps.expired
                ? t('product_set_status_expired')
                : t(ps.status === 'pending_payment' ? 'product_set_status_pending_payment' : 'product_set_status_draft')}
              {ps.amount_due != null ? ` · ${ps.amount_due.toFixed(2)} €` : ''}
            </span>
            {ps.status === 'draft' && changes.length > 0 && (
              <ul data-summary-changes style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                {(changes as ChangeLike[]).map((c, i) => {
                  const m = changeMessage(c);
                  const tone = c.kind === 'added' || c.kind === 'promotion_added'
                    ? '#15803d'
                    : c.kind === 'removed' || c.kind === 'promotion_removed' ? '#b91c1c' : undefined;
                  return <li key={i} data-change-kind={c.kind} style={tone ? { color: tone } : undefined}>{t(m.key as any, m.values as any)}</li>;
                })}
              </ul>
            )}
            {ps.status === 'draft' && items.length > 0 && (
              <ul data-summary-items style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                {items.map((i, n) => {
                  const parts = [
                    t(i.type === 'plan' ? 'summary_type_plan' : 'summary_type_product'),
                    i.quantity != null ? `× ${i.quantity}` : null,
                    i.billing_frequency ? i.billing_frequency.replace('_', ' ') : null,
                    i.regular_price != null ? `${t('summary_regular')}: ${i.regular_price.toFixed(2)} €` : null,
                    i.promotions.length > 0 ? i.promotions.join(', ') : null,
                    i.final_price != null ? `${t('summary_final')}: ${i.final_price.toFixed(2)} €` : null,
                    i.initial_amount != null ? `${t('summary_initial')}: ${i.initial_amount.toFixed(2)} €` : null,
                  ].filter(Boolean).join(' · ');
                  const tone = i.state === 'draft' ? '#15803d' : i.state === 'cancelling' ? '#b91c1c' : undefined;
                  return (
                    <li key={n} data-summary-item-state={i.state} style={tone ? { color: tone } : undefined}>
                      <strong>{i.name}</strong> <span style={cardHintStyle}>({t(`summary_state_${i.state}` as any)})</span> — {parts}
                    </li>
                  );
                })}
              </ul>
            )}
            {ps.status === 'draft' && financial && (
              <div data-financial-summary style={{ marginTop: 8, fontSize: 13 }}>
                <div style={cardSubLabelStyle}>{t('summary_financial')}</div>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {financial.recurring.map((r, n) => (
                    <li key={n} data-recurring-frequency={r.billing_frequency ?? ''}>
                      {r.billing_frequency ? `${r.billing_frequency.replace('_', ' ')}: ` : ''}
                      {[
                        `${t('summary_existing')} ${r.existing.toFixed(2)} €`,
                        `${t('summary_new')} ${r.new.toFixed(2)} €`,
                        `${t('summary_cancelling')} ${r.cancelling.toFixed(2)} €`,
                        `${t('summary_resulting')} ${r.resulting.toFixed(2)} €`,
                      ].join(' · ')}
                    </li>
                  ))}
                  {financial.initial_discounts > 0 && (
                    <li>{t('summary_discounts')}: −{financial.initial_discounts.toFixed(2)} €</li>
                  )}
                  {financial.amount_payable != null && (
                    <li><strong>{t('summary_amount_payable')}: {financial.amount_payable.toFixed(2)} €</strong></li>
                  )}
                </ul>
              </div>
            )}
            {link?.id === ps.id && (
              <div style={cardHintStyle}>{t('product_set_payment_link')}: <code>{link.url}</code></div>
            )}
          </div>
          {canWrite && (
            ps.status === 'pending_payment' && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ps.status === 'pending_payment' && (
                <>
                  <button
                    disabled={busyId === ps.id}
                    style={secondaryBtnSmall}
                    onClick={() => run(ps.id, async () => {
                      const pay = await apiFetch<{ checkout_url: string }>(`/product-sets/${ps.id}/save-and-pay`, {
                        method: 'POST', body: JSON.stringify({}),
                      });
                      setLink({ id: ps.id, url: pay.checkout_url });
                      try { await navigator.clipboard?.writeText(pay.checkout_url); } catch { /* shown on screen */ }
                    })}
                  >
                    {t('product_set_action_payment_link')}
                  </button>
                  <button
                    disabled={busyId === ps.id}
                    style={primaryBtnSmall()}
                    onClick={() => run(ps.id, async () => {
                      await apiFetch(`/product-sets/${ps.id}/record-payment`, { method: 'POST', body: JSON.stringify({}) });
                    })}
                  >
                    {t('product_set_action_record_cash')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      {error && <p style={{ ...formErrorStyle, margin: '6px 0 0' }}>{error}</p>}
    </div>
  );
}

const row: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', margin: '6px 0',
  border: '1px solid var(--gd-card-border, #e5e7eb)', borderRadius: 8, flexWrap: 'wrap',
};
