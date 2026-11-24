'use client';

// #3270 / #3288 — the heading that identifies a purchase in the Summary: the purchase's stored
// canonical name, verbatim (`lib/purchaseName.ts`), and beside it the purchase's current status as a
// separate badge. The name is never the plan's, so it stays the same when the cart's plan, Products
// or status change.

import React from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { purchaseStatusKey, type PurchaseLike } from '@/lib/purchaseName';

export function PurchaseHeading({ purchase, statusOverride }: {
  purchase: PurchaseLike;
  /** A status the row states beyond the purchase's own (an expired Draft). */
  statusOverride?: { status: string; label: string } | null;
}) {
  const t = useTranslations('members');
  const key = purchaseStatusKey(purchase.status);
  const status = statusOverride ?? (key ? { status: purchase.status, label: t(key as any) } : null);
  return (
    <span data-purchase-heading={purchase.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <strong data-purchase-name>{purchase.name}</strong>
      {status && <span data-purchase-status={status.status}><StatusBadge status={status.status} label={status.label} /></span>}
    </span>
  );
}
