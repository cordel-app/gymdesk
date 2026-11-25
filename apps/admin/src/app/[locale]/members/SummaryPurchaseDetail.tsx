'use client';

// #3307 stage 4 — the Products Summary's row for a cart Save & Pay submitted can be opened to show
// the purchase's contents and its Billing Events, drawn by the Purchases tab's own expanded body
// (`PurchaseDetailBody`). The read is that tab's (`GET /payments/purchases`, narrowed to the one
// purchase) and is made only when the detail is opened; nothing here submits or charges.

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { cardMutedTextStyle, formErrorStyle, secondaryBtnSmall } from '@/components/formChrome';
import { PurchaseDetailBody } from './MemberPurchases';
import type { MemberPurchase } from './purchasesTabView';

export function SummaryPurchaseDetailToggle({ open, onToggle, purchaseId }: {
  open: boolean; onToggle: () => void; purchaseId: number;
}) {
  const t = useTranslations('members');
  return (
    <button type="button" style={secondaryBtnSmall} aria-expanded={open} data-summary-purchase-toggle={purchaseId} onClick={onToggle}>
      {t(open ? 'summary_purchase_hide_details' : 'summary_purchase_show_details')}
    </button>
  );
}

export function SummaryPurchaseDetail({ memberId, purchaseId, reloadKey }: {
  memberId: number | string; purchaseId: number; reloadKey?: unknown;
}) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const [purchase, setPurchase] = useState<MemberPurchase | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    apiFetch<{ items: MemberPurchase[] }>(`/payments/purchases?member_id=${memberId}&purchase_id=${purchaseId}&limit=1`)
      .then((r) => { if (live) setPurchase(r.items?.[0] ?? null); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId, purchaseId, reloadKey]);

  if (failed) return <p style={formErrorStyle}>{t('purchases_error')}</p>;
  if (purchase === undefined) return <p style={cardMutedTextStyle}>{t('purchases_loading')}</p>;
  if (purchase === null) return <p style={cardMutedTextStyle}>{t('purchases_no_items')}</p>;
  return <div data-summary-purchase-detail={purchaseId}><PurchaseDetailBody p={purchase} /></div>;
}
