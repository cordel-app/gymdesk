'use client';

// #2965 — the Summary of a cart that holds only standalone one-time Products (no Draft Product Set
// carries them; when one does, the Draft's review already lists them). It draws the same two
// sections as the Draft's Summary from `GET /members/:id/product-purchases/cart-summary`, whose
// figures are the very ones `POST …/checkout` charges: nothing here adds anything up.

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { cardHintStyle, cardSubLabelStyle } from '@/components/formChrome';
import { ContractedItemsSection, InitialPaymentSection } from './CheckoutSummarySections';
import type { ContractedItemLike, InitialPaymentLike } from './productsWorkflowView';

interface CartSummary {
  initial_payment: InitialPaymentLike;
  contracted_items: ContractedItemLike[];
  amount_due: number;
}

export function StandaloneCartSummary({ memberId, reloadKey, paymentLink }: {
  memberId: number;
  /** Re-read whenever the member's purchases were. */
  reloadKey: unknown;
  /** The checkout link of the last cart Save & Pay, shown once it exists. */
  paymentLink?: string | null;
}) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const [summary, setSummary] = useState<CartSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<CartSummary>(`/members/${memberId}/product-purchases/cart-summary`)
      .then((r) => { if (!cancelled) setSummary(r); })
      .catch(() => { if (!cancelled) setSummary(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId, reloadKey]);

  return (
    <div data-checkout-summary data-standalone-cart style={{ marginBottom: 12 }}>
      {summary && (
        <>
          <div style={cardSubLabelStyle}>{t('checkout_initial_payment')}</div>
          <InitialPaymentSection payment={summary.initial_payment} />
          <div style={{ ...cardSubLabelStyle, marginTop: 12 }}>{t('checkout_contracted')}</div>
          <ContractedItemsSection items={summary.contracted_items} />
        </>
      )}
      {paymentLink && (
        <div style={cardHintStyle}>{t('product_set_payment_link')}: <code>{paymentLink}</code></div>
      )}
    </div>
  );
}
