'use client';

// #3307 — the cart Save & Pay just committed, kept in the Summary once it has left the in-flight
// rows (paid in cash or by card, settled by the provider, or activated because nothing was owed).
// Everything shown is the server's: the version, its purchase (name and status) and the initial
// Billing Event are re-read from `GET /product-sets/:id` whenever the configuration is. Nothing here
// submits, charges or decides a status; the only action opens the existing Billing Event details.

import React, { useEffect, useState, type CSSProperties } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { StatusBadge } from '@/components/StatusBadge';
import { cardHintStyle, secondaryBtnSmall } from '@/components/formChrome';
import type { PurchaseLike } from '@/lib/purchaseName';
import { PurchaseHeading } from './PurchaseHeading';
import { psStatusKey, submittedCartNoteKey, type SubmittedCart } from './productsWorkflowView';

interface SetRead {
  id: number;
  status: string;
  purchase: PurchaseLike | null;
  billing_events: Array<{ id: number; event_type: string; amount: number | string }>;
}

export function SubmittedCartSummary({ submitted, reloadKey }: { submitted: SubmittedCart; reloadKey: unknown }) {
  const t = useTranslations('members');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const [set, setSet] = useState<SetRead | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<SetRead>(`/product-sets/${submitted.productSetId}`)
      .then((r) => { if (!cancelled) setSet(r); })
      .catch(() => { if (!cancelled) setSet(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted.productSetId, reloadKey]);

  if (!set) return null;
  // The initial charge is the version's latest `payment_recorded` event (`ensureInitialEvent()`).
  const initial = [...set.billing_events].reverse().find((e) => e.event_type === 'payment_recorded') ?? null;
  const statusKey = psStatusKey({ status: set.status } as any);
  const noteKey = submittedCartNoteKey(submitted.outcome);
  return (
    <div style={row} data-submitted-cart={set.id}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {set.purchase ? (
          <PurchaseHeading purchase={set.purchase} />
        ) : statusKey ? (
          <StatusBadge status={statusKey} label={t(`ps_status_${statusKey}` as any)} />
        ) : null}
        {initial && <span style={cardHintStyle}>{` · ${Number(initial.amount).toFixed(2)} €`}</span>}
        {noteKey && <div style={cardHintStyle} data-submitted-cart-note>{t(noteKey as any)}</div>}
        {submitted.checkoutUrl && (
          <div style={cardHintStyle}>{t('product_set_payment_link')}: <code>{submitted.checkoutUrl}</code></div>
        )}
      </div>
      {initial && (
        <button
          type="button"
          style={secondaryBtnSmall}
          data-submitted-cart-billing-event={initial.id}
          onClick={() => router.push(`/${locale}/payments/billing-events?id=${Number(initial.id)}`)}
        >
          {t('action_view_billing_event')}
        </button>
      )}
    </div>
  );
}

const row: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', margin: '6px 0 12px',
  border: '1px solid var(--gd-card-border, #e5e7eb)', borderRadius: 8, flexWrap: 'wrap',
};
