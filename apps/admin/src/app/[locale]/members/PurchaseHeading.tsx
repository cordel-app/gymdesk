'use client';

// #3270 / #3288 — the heading that identifies a purchase in the Summary: the purchase's stored
// canonical name, verbatim (`lib/purchaseName.ts`), and beside it the purchase's current status as a
// separate badge. The name is never the plan's, so it stays the same when the cart's plan, Products
// or status change.
//
// #3378 — while the purchase is In Cart, the cart's expiry countdown sits right after the status
// badge (`expiry`), so the header is the one place the cart's status and its countdown are shown.

import React from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { purchaseStatusKey, type PurchaseLike } from '@/lib/purchaseName';
import { CartExpiryIndicator } from './CartExpiryIndicator';

/** #3378 — the cart's countdown (the server's seconds) and what to do when it reaches zero. */
export interface CartExpiry { seconds: number | null; onExpire?: () => void }

export function PurchaseHeading({ purchase, statusOverride, expiry }: {
  purchase: PurchaseLike;
  /** A status the row states beyond the purchase's own (an expired Draft). */
  statusOverride?: { status: string; label: string } | null;
  /** #3378 — the cart's countdown, drawn next to the status only while the purchase is In Cart. */
  expiry?: CartExpiry | null;
}) {
  const t = useTranslations('members');
  const key = purchaseStatusKey(purchase.status);
  const status = statusOverride ?? (key ? { status: purchase.status, label: t(key as any) } : null);
  return (
    <span data-purchase-heading={purchase.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <strong data-purchase-name>{purchase.name}</strong>
      {status && <span data-purchase-status={status.status}><StatusBadge status={status.status} label={status.label} /></span>}
      {expiry && status?.status === 'in_cart' && <CartExpiryIndicator seconds={expiry.seconds} onExpire={expiry.onExpire} />}
    </span>
  );
}
