'use client';

// #2965 — the Summary of a cart that holds only standalone one-time Products (no Draft Product Set
// carries them; when one does, the Draft's review already lists them). It draws the same two
// sections as the Draft's Summary from `GET /members/:id/product-purchases/cart-summary`, whose
// figures are the very ones `POST …/checkout` charges: nothing here adds anything up.

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { cardHintStyle } from '@/components/formChrome';
import { CheckoutSummaryPanel } from './CheckoutSummarySections';
import { PurchaseHeading, type CartExpiry } from './PurchaseHeading';
import type { PurchaseLike } from '@/lib/purchaseName';
import type { ContractedItemLike, InitialPaymentLike } from './productsWorkflowView';

interface CartSummary {
  /** #3270 — the purchase (cart) these lines belong to: its persisted name basis and status. */
  purchase?: PurchaseLike | null;
  initial_payment: InitialPaymentLike;
  contracted_items: ContractedItemLike[];
  amount_due: number;
}

export function StandaloneCartSummary({ memberId, reloadKey, paymentLink, cartExpiry = null }: {
  memberId: number;
  /** Re-read whenever the member's purchases were. */
  reloadKey: unknown;
  /** The checkout link of the last cart Save & Pay, shown once it exists. */
  paymentLink?: string | null;
  /** #3378 — the cart's countdown, shown in the purchase header beside its In Cart status. */
  cartExpiry?: CartExpiry | null;
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
    <div data-standalone-cart style={{ marginBottom: 12 }}>
      {summary?.purchase && <PurchaseHeading purchase={summary.purchase} expiry={cartExpiry} />}
      {summary && <CheckoutSummaryPanel payment={summary.initial_payment} contracted={summary.contracted_items} />}
      {paymentLink && (
        <div style={cardHintStyle}>{t('product_set_payment_link')}: <code>{paymentLink}</code></div>
      )}
    </div>
  );
}
