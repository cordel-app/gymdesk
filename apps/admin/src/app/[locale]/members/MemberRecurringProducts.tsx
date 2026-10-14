'use client';

// #1537 — the **Recurring products** section of the Products tab.
//
// `Recurring products: [Active | Draft]`, the recurring lines of the member's
// current version and one global **Save & Pay**. There is no "create draft"
// step: the first edit (Edit, `+ Add Product`, a quantity, a removal) asks the
// server for the member's Draft — `POST /product-sets/draft`, idempotent — and
// every later one lands on that same Draft. The Active version is never touched
// until the Draft is committed; cancelling the Draft restores it (or the empty
// state). Committing goes through the existing `save-and-pay` / `activate`
// routes behind the **Review your changes** modal; nothing here prices, charges
// or decides lifecycle.

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { StatusBadge } from '@/components/StatusBadge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CardDetailRow } from '@/components/CardDetailRow';
import { BILLING_FREQUENCY_NAMESPACE, billingFrequencyLabel } from '@/lib/billingFrequency';
import {
  cardHintStyle, formControlStyle, formErrorStyle, inlineActionsRowStyle, innerCardStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import type { ProductSetSummary } from './membershipConfiguration';
import { AddProductPurchase } from './AddProductPurchase';
import { ReviewChangesModal } from './ReviewChangesModal';
import { editableLines, recurringState, type EditableLine } from './recurringProductsView';

interface Detail { configuration?: Parameters<typeof editableLines>[0] }

export function MemberRecurringProducts({
  memberId, current, reloadKey, canWrite, isAdmin, onChanged, reviewing, onReviewingChange,
}: {
  /** #1613 — the review modal is opened by the tab's one global Save & Pay. */
  reviewing: boolean;
  onReviewingChange: (open: boolean) => void;
  memberId: number;
  /** The in-flight version, else the Active one (`current_product_set`). */
  current: ProductSetSummary | null;
  /** Changes whenever the member's configuration was re-read. */
  reloadKey: unknown;
  canWrite: boolean;
  isAdmin: boolean;
  /** A version changed server-side: re-read the member's configuration. */
  onChanged: () => void;
}) {
  const t = useTranslations('members');
  const tFreq = useTranslations(BILLING_FREQUENCY_NAMESPACE);
  const { apiFetch } = useApiClient();
  const state = recurringState(current, canWrite);

  const [lines, setLines] = useState<EditableLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  const setId = current?.id ?? null;
  useEffect(() => {
    if (setId == null) { setLines([]); return; }
    let cancelled = false;
    setLoading(true);
    apiFetch<Detail>(`/product-sets/${setId}`)
      .then((d) => { if (!cancelled) setLines(editableLines(d.configuration)); })
      .catch(() => { if (!cancelled) setLines([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setId, current?.status, reloadKey]);

  function describe(err: any): string {
    const code = err?.body?.error ?? err?.message;
    if (code === 'draft_expired') return t('review_error_expired');
    if (code === 'edit_locked') return t('review_error_locked');
    if (code === 'in_flight') return t('recurring_error_in_flight');
    return apiErrorMessage(err) ?? t('error_generic');
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err: any) {
      setError(describe(err));
      // An expired or vanished Draft: re-read so the section shows what is real.
      if (err?.status === 410 || err?.status === 404) onChanged();
    } finally {
      setBusy(false);
    }
  }

  /** The Draft every edit goes to: the member's own, created on the first edit. */
  async function ensureDraft(): Promise<number> {
    if (current?.status === 'draft' && !current.expired) return current.id;
    const res = await apiFetch<{ id: number }>('/product-sets/draft', {
      method: 'POST', body: JSON.stringify({ member_id: memberId }),
    });
    return res.id;
  }

  const startEdit = () => run(async () => { await ensureDraft(); onChanged(); });

  const changeQuantity = (line: EditableLine, quantity: number) => run(async () => {
    if (line.serviceId == null || !Number.isInteger(quantity) || quantity < 1) return;
    const id = await ensureDraft();
    await apiFetch(`/product-sets/${id}/services/${line.serviceId}`, { method: 'PUT', body: JSON.stringify({ quantity }) });
    onChanged();
  });

  const removeLine = (line: EditableLine) => run(async () => {
    if (line.serviceId == null) return;
    const id = await ensureDraft();
    await apiFetch(`/product-sets/${id}/services/${line.serviceId}`, { method: 'DELETE' });
    onChanged();
  });

  const cancelDraft = () => run(async () => {
    if (setId == null) return;
    try {
      await apiFetch(`/product-sets/${setId}`, { method: 'DELETE' });
    } finally {
      setConfirmCancel(false);
      onChanged();
    }
  });

  const dash = '—';

  return (
    <div style={innerCardStyle} data-recurring-products data-recurring-status={state.chip ?? 'none'}>
      {/* #1613 — the title and status chip are gone: the tab's PS Status chip says it. */}
      {(state.paymentPending || state.expired) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {state.paymentPending && <span style={cardHintStyle}>{t('recurring_payment_pending')}</span>}
          {state.expired && <span style={cardHintStyle}>{t('recurring_expired')}</span>}
        </div>
      )}

      {state.chip == null && <p style={cardHintStyle}>{t('recurring_empty')}</p>}
      {state.chip != null && loading && <p style={cardHintStyle}>{t('product_set_loading')}</p>}
      {state.chip != null && !loading && lines.length === 0 && <p style={cardHintStyle}>{t('product_set_no_products')}</p>}

      {lines.map((l) => {
        const freq = billingFrequencyLabel(l.billingFrequency, (k) => tFreq(k as any));
        const editableLine = state.editing && l.serviceId != null;
        return (
          <div key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0' }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <CardDetailRow
                label={l.name}
                value={`${l.quantity} × €${l.unitPrice.toFixed(2)}${freq ? ` · ${freq}` : ''}`}
              />
            </div>
            {editableLine && (
              <>
                <input
                  type="number"
                  min={1}
                  max={999}
                  aria-label={t('recurring_quantity', { name: l.name })}
                  style={{ ...formControlStyle, width: 72 }}
                  defaultValue={l.quantity}
                  key={`${l.key}-${l.quantity}`}
                  disabled={busy}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (n !== l.quantity) changeQuantity(l, n);
                  }}
                />
                <button type="button" style={secondaryBtnSmall} disabled={busy} onClick={() => removeLine(l)}>
                  {t('recurring_remove')}
                </button>
              </>
            )}
          </div>
        );
      })}

      {adding && (
        <AddProductPurchase
          memberId={memberId}
          isAdmin={isAdmin}
          canPay={canWrite}
          recurringOnly
          onClose={() => setAdding(false)}
          onChanged={onChanged}
        />
      )}

      {checkoutUrl && (
        <p style={{ fontSize: 14 }}>
          {t('add_product_purchase_created')}{' '}
          <a href={checkoutUrl} target="_blank" rel="noreferrer">{t('add_product_payment_link')}</a>
        </p>
      )}
      {notice && <p style={cardHintStyle}>{notice}</p>}
      {error && <p role="alert" style={formErrorStyle}>{error}</p>}

      {canWrite && (
        <div style={{ ...inlineActionsRowStyle, marginTop: 8 }}>
          {!adding && !state.paymentPending && (
            <button type="button" style={primaryBtnSmall()} disabled={busy} onClick={() => setAdding(true)}>
              {t('recurring_add_product')}
            </button>
          )}
          {state.canStartEdit && (
            <button type="button" style={secondaryBtnSmall} disabled={busy} onClick={startEdit}>{t('edit')}</button>
          )}
          {state.canCancel && (
            <button type="button" style={secondaryBtnSmall} disabled={busy} onClick={() => setConfirmCancel(true)}>
              {t('recurring_cancel')}
            </button>
          )}
        </div>
      )}
      {!canWrite && <p style={cardHintStyle}>{dash}</p>}

      {setId != null && (
        <ReviewChangesModal
          productSetId={setId}
          open={reviewing}
          onClose={() => onReviewingChange(false)}
          onCommitted={({ activated, checkoutUrl: url }) => {
            onReviewingChange(false);
            setCheckoutUrl(url);
            setNotice(activated ? t('add_product_activated') : null);
            onChanged();
          }}
        />
      )}

      <ConfirmDialog
        open={confirmCancel}
        message={t('recurring_cancel_confirm')}
        confirmLabel={t('recurring_cancel')}
        cancelLabel={t('close')}
        busy={busy}
        onConfirm={cancelDraft}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}
