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
import type { ReviewSummary } from './productsWorkflowView';
import { ContractedItemsSection, InitialPaymentSection } from './CheckoutSummarySections';

interface Props {
  productSets: ProductSetRow[];
  canWrite: boolean;
  /**
   * #2860 — the Draft's review: the Summary draws its Initial Payment and its
   * Contracted Products & Plans (replacing #1660's diff list and #2446's items
   * and financial summary).
   */
  review?: ReviewSummary | null;
  /** Re-reads the Member's configuration after an action. */
  onChanged: () => void;
}

export function ProductSetsInFlight({ productSets, canWrite, review = null, onChanged }: Props) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [link, setLink] = useState<{ id: number; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inFlight = productSets.filter((p) => p.status === 'in_cart' || p.status === 'pending_payment');
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
                : t(ps.status === 'pending_payment' ? 'product_set_status_pending_payment' : 'product_set_status_in_cart')}
              {ps.amount_due != null ? ` · ${ps.amount_due.toFixed(2)} €` : ''}
            </span>
            {ps.status === 'in_cart' && review && (
              <div data-checkout-summary style={{ marginTop: 8 }}>
                <div style={cardSubLabelStyle}>{t('checkout_initial_payment')}</div>
                <InitialPaymentSection payment={review.initial_payment} />
                <div style={{ ...cardSubLabelStyle, marginTop: 12 }}>{t('checkout_contracted')}</div>
                <ContractedItemsSection items={review.contracted_items} />
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
