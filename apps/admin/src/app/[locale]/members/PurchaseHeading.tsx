'use client';

// #3270 — the heading that identifies an In-Cart purchase in the Summary: the translated "Purchase"
// label with the purchase's persisted creation instant in the browser's own locale and time zone
// (`lib/purchaseName.ts`), and beside it the purchase's current status as a separate badge. The name
// is never the plan's, so it stays the same when the cart's plan, Products or status change.

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { formatPurchaseInstant, purchaseStatusKey, type PurchaseLike } from '@/lib/purchaseName';

export function PurchaseHeading({ purchase, statusOverride }: {
  purchase: PurchaseLike;
  /** A status the row states beyond the purchase's own (an expired Draft). */
  statusOverride?: { status: string; label: string } | null;
}) {
  const t = useTranslations('members');
  // The browser's locale and zone are only known in the browser: formatted after mount, so the
  // server-rendered markup and the first client render agree.
  const [date, setDate] = useState<string | null>(null);
  useEffect(() => { setDate(formatPurchaseInstant(purchase.name)); }, [purchase.name]);
  const key = purchaseStatusKey(purchase.status);
  const status = statusOverride ?? (key ? { status: purchase.status, label: t(key as any) } : null);
  return (
    <span data-purchase-heading={purchase.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <strong data-purchase-name>{t('purchase_name', { date: date ?? '' })}</strong>
      {status && <span data-purchase-status={status.status}><StatusBadge status={status.status} label={status.label} /></span>}
    </span>
  );
}
