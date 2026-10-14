'use client';

// #1613 — the Products tab's header: the ProductSet's **PS Status** and the one
// global **Save & Pay**, plus the hook that reads the Draft's review so the
// billing section's mode is the server's answer about billing impact and never
// a dirty flag. Nothing here prices, charges or decides lifecycle.

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { StatusBadge } from '@/components/StatusBadge';
import { cardHintStyle, cardSectionLabelStyle } from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import type { ProductSetSummary } from './membershipConfiguration';
import { psStatusKey, saveAndPayEnabled, type ReviewSummary, type WorkflowInput } from './productsWorkflowView';

/** The Draft's review (`changes` + `amount_due`), re-read whenever the configuration was. */
export function useDraftReview(current: ProductSetSummary | null, reloadKey: unknown): ReviewSummary | null {
  const { apiFetch } = useApiClient();
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const id = current?.status === 'draft' && !current.expired ? current.id : null;
  useEffect(() => {
    if (id == null) { setReview(null); return; }
    let cancelled = false;
    apiFetch<ReviewSummary>(`/product-sets/${id}/review`)
      .then((r) => { if (!cancelled) setReview({ changes: r.changes ?? [], amount_due: r.amount_due ?? null }); })
      .catch(() => { if (!cancelled) setReview(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadKey]);
  return review;
}

export function ProductsWorkflowBar({
  current, loading, error, workflow, canWrite, busy, onSaveAndPay,
}: {
  current: ProductSetSummary | null;
  loading: boolean;
  error: boolean;
  workflow: WorkflowInput;
  canWrite: boolean;
  busy?: boolean;
  onSaveAndPay: () => void;
}) {
  const t = useTranslations('members');
  const statusKey = psStatusKey(current);
  const enabled = saveAndPayEnabled({ ...workflow, canWrite });
  return (
    <div
      data-ps-status-bar
      style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}
    >
      <span style={{ ...cardSectionLabelStyle, margin: 0 }}>{t('ps_status_label')}</span>
      {loading ? (
        <span style={cardHintStyle}>{t('product_set_loading')}</span>
      ) : error ? (
        <span style={cardHintStyle}>{t('product_set_error')}</span>
      ) : statusKey ? (
        <StatusBadge status={statusKey} label={t(`ps_status_${statusKey}` as any)} />
      ) : (
        <StatusBadge status="none" label={t('ps_status_none')} />
      )}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        data-global-save-and-pay
        style={{ ...primaryBtnSmall(), opacity: enabled && !busy ? 1 : 0.5, cursor: enabled && !busy ? 'pointer' : 'not-allowed' }}
        disabled={!enabled || busy}
        onClick={onSaveAndPay}
      >
        {t('add_product_save_and_pay')}
      </button>
    </div>
  );
}
