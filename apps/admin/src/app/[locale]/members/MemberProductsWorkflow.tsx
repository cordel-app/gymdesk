'use client';

// #1613 — the Products tab's header: the ProductSet's **PS Status** and the one
// global **Save & Pay**, plus the hook that reads the Draft's review so the
// billing section's mode is the server's answer about billing impact and never
// a dirty flag. Nothing here prices, charges or decides lifecycle.

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { StatusBadge } from '@/components/StatusBadge';
import { cardHintStyle, cardSectionLabelStyle, formErrorStyle } from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import { secondaryBtnSmall } from '@/components/formChrome';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { ProductSetSummary } from './membershipConfiguration';
import { cancelRequestFor, pendingCancelErrorKey, psStatusKey, saveAndPayEnabled, type ReviewSummary, type WorkflowInput } from './productsWorkflowView';
import { DraftExpiryIndicator } from './DraftExpiryIndicator';

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

/**
 * The PS Status header only (#2446): the actions live in the Summary.
 *
 * #2815 — a Draft's expiry countdown sits beside the chip. It is the one
 * `DraftExpiryIndicator` (#2477), counting down from the server's
 * `expires_in_seconds`; nothing here computes an expiry.
 */
export function ProductsWorkflowBar({
  current, loading, error, onDraftExpired,
}: {
  current: ProductSetSummary | null;
  loading: boolean;
  error: boolean;
  /** The Draft's time ran out; the page re-reads the configuration. */
  onDraftExpired?: () => void;
}) {
  const t = useTranslations('members');
  const statusKey = psStatusKey(current);
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
      {!loading && !error && current?.status === 'draft' && !current.expired && (
        <DraftExpiryIndicator seconds={current.expires_in_seconds} onExpire={onDraftExpired} />
      )}
    </div>
  );
}

/** #2446 — the one global Save & Pay and Cancel, rendered at the bottom-left of the Summary. */
export function ProductsWorkflowActions({
  current, workflow, canWrite, busy, onSaveAndPay, onDiscarded,
}: {
  current: ProductSetSummary | null;
  workflow: WorkflowInput;
  canWrite: boolean;
  busy?: boolean;
  onSaveAndPay: () => void;
  /** The Draft was discarded server-side; the page re-reads the configuration. */
  onDiscarded?: () => void;
}) {
  const t = useTranslations('members');
  const enabled = saveAndPayEnabled({ ...workflow, canWrite });
  const { apiFetch } = useApiClient();
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  // #1881 — the same in-flight version the Recurring section's Cancel acts on.
  // #2747 stage 2: a Draft is discarded; a version awaiting payment is cancelled
  // and kept (`cancelRequestFor()`), and the server refuses it while a payment
  // settled or is still unresolved.
  const request = canWrite ? cancelRequestFor(current) : null;
  const canDiscard = request != null;
  const pending = request?.kind === 'cancel_pending';
  const discard = async () => {
    if (!request) return;
    setDiscarding(true);
    setDiscardError(null);
    try {
      await apiFetch(request.path, { method: request.method });
      setConfirming(false);
      onDiscarded?.();
    } catch (e: any) {
      setConfirming(false);
      setDiscardError(pending ? t(pendingCancelErrorKey(e?.message) as any) : (e?.message || t('ps_discard_error')));
      if (pending) onDiscarded?.();
    } finally {
      setDiscarding(false);
    }
  };
  return (
    <div data-summary-actions style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
      <button
        type="button"
        data-global-save-and-pay
        style={{ ...primaryBtnSmall(), opacity: enabled && !busy ? 1 : 0.5, cursor: enabled && !busy ? 'pointer' : 'not-allowed' }}
        disabled={!enabled || busy}
        onClick={onSaveAndPay}
      >
        {t('add_product_save_and_pay')}
      </button>
      {canDiscard && (
        <button
          type="button"
          data-global-cancel-draft
          style={secondaryBtnSmall}
          disabled={busy || discarding}
          onClick={() => setConfirming(true)}
        >
          {t('ps_cancel')}
        </button>
      )}
      {discardError && <p role="alert" style={{ ...formErrorStyle, flexBasis: '100%', margin: 0 }}>{discardError}</p>}
      <ConfirmDialog
        open={confirming}
        message={pending
          ? `${t('ps_cancel_pending_title')} ${t('ps_cancel_pending_confirm')}`
          : `${t('ps_cancel_title')} ${t('ps_cancel_confirm')}`}
        confirmLabel={t(pending ? 'ps_cancel_pending_action' : 'ps_cancel_discard')}
        cancelLabel={t(pending ? 'ps_cancel_pending_keep' : 'ps_cancel_keep')}
        busy={discarding}
        onConfirm={discard}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
