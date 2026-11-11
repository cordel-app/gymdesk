'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { overlayStyle, modalStyle, primaryBtnStyle } from '@/components/ui';
import { formControlStyle, formFieldLabelStyle, modalActionsRowStyle, secondaryBtnStyle } from '@/components/formChrome';
import { fmtAmount } from './BillingEventExpandedRow';
import {
  RefundKind, RefundMethodCode, RefundOptions, adhocAmountError, canAcceptRefund, lineSelectable,
  refundAmount, refundRequestBody, selectedLinesTotal,
} from './refundForm';

/**
 * #2480 — the Refund modal: Full Refund, Selected Line Items Refund or Ad-hoc
 * Refund, through a payment method chosen from those the API offers for this
 * payment. It records nothing until **Accept**; Cancel and the backdrop close
 * it and change nothing. Accept is disabled while the request is in flight,
 * and the server re-judges every amount under the event's lock.
 */
export function RefundModal({
  billingEventId, memberName, currency, onDone, onClose,
}: {
  billingEventId: number;
  memberName: string;
  currency: string;
  onDone: (result: { status: string; amount: string }) => void;
  onClose: () => void;
}) {
  const t = useTranslations('billing_events_page');
  const { apiFetch } = useApiClient();
  const [opts, setOpts] = useState<RefundOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<RefundKind>('full');
  const [method, setMethod] = useState<RefundMethodCode | ''>('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adhoc, setAdhoc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<RefundOptions>(`/payments/billing-events/${billingEventId}/refund-options`)
      .then((o) => { setOpts(o); setMethod(o.methods[0]?.code ?? ''); })
      .catch((e: any) => setLoadError(e?.message ?? t('action_error')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingEventId]);

  const amount = useMemo(() => (opts ? refundAmount(kind, opts, selected, adhoc) : null), [opts, kind, selected, adhoc]);
  const dismiss = () => { if (!busy) onClose(); };
  const money = (v: string | null) => `${fmtAmount(v)} ${currency}`;

  async function accept() {
    if (!opts || !method || !canAcceptRefund(kind, opts, selected, adhoc, method, busy)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ status: string; amount: string }>(`/payments/billing-events/${billingEventId}/refund`, {
        method: 'POST', body: JSON.stringify(refundRequestBody(kind, method, selected, adhoc)),
      });
      onDone(res);
    } catch (e: any) {
      setError(e?.message ?? t('action_error'));
    } finally {
      setBusy(false);
    }
  }

  const adhocError = opts && kind === 'adhoc' && adhoc.trim() ? adhocAmountError(adhoc, opts) : null;
  const acceptable = !!opts && !!method && canAcceptRefund(kind, opts, selected, adhoc, method, busy);
  const radio = (k: RefundKind) => (
    <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
      <input type="radio" name="refund-kind" checked={kind === k} onChange={() => setKind(k)} disabled={busy} />
      {t(`refund_kind_${k}`)}
    </label>
  );

  return (
    <div style={overlayStyle} onClick={dismiss}>
      <div role="dialog" aria-modal="true" aria-label={t('refund_modal_title')}
        style={{ ...modalStyle, width: 520, maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>{t('refund_modal_title')}</h2>
        {loadError && <p role="alert" style={{ color: '#991b1b', fontSize: 13 }}>{loadError}</p>}
        {!opts && !loadError && <p style={{ color: '#6b7280', fontSize: 13 }}>{t('loading')}</p>}
        {opts && (
          <>
            <dl style={{ margin: '0 0 14px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 14 }}>
              <dt style={{ color: '#6b7280' }}>{t('modal_member')}</dt>
              <dd style={{ margin: 0, fontWeight: 600 }}>{memberName}</dd>
              <dt style={{ color: '#6b7280' }}>{t('refund_collected')}</dt>
              <dd style={{ margin: 0 }}>{money(opts.collected_amount)}</dd>
              <dt style={{ color: '#6b7280' }}>{t('refund_already_refunded')}</dt>
              <dd style={{ margin: 0 }}>{money(opts.refunded_amount)}</dd>
              <dt style={{ color: '#6b7280' }}>{t('refund_refundable')}</dt>
              <dd style={{ margin: 0, fontWeight: 600 }}>{money(opts.refundable_amount)}</dd>
            </dl>

            <div role="radiogroup" aria-label={t('refund_kind_label')} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              {(['full', 'lines', 'adhoc'] as const).map(radio)}
            </div>

            {kind === 'lines' && (
              <div style={{ marginBottom: 12 }}>
                {opts.lines.length === 0 && <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>{t('refund_no_lines')}</p>}
                {opts.lines.map((l) => (
                  <label key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '3px 0', opacity: lineSelectable(l) ? 1 : 0.55 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      disabled={busy || !lineSelectable(l)}
                      onChange={(e) => setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(l.id); else next.delete(l.id);
                        return next;
                      })}
                    />
                    <span style={{ flex: 1 }}>{l.item_name}{l.quantity > 1 ? ` × ${l.quantity}` : ''}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {money(l.refundable_amount)}
                      {Number(l.refunded_amount) > 0 && <span style={{ color: '#6b7280' }}> ({t('refund_line_refunded', { amount: money(l.refunded_amount) })})</span>}
                    </span>
                  </label>
                ))}
                <p style={{ margin: '6px 0 0', fontSize: 13, fontWeight: 600 }}>
                  {t('refund_selected_total', { amount: money(selectedLinesTotal(opts.lines, selected)) })}
                </p>
              </div>
            )}

            {kind === 'adhoc' && (
              <div style={{ marginBottom: 12 }}>
                <label style={formFieldLabelStyle} htmlFor="refund-adhoc">{t('refund_adhoc_amount')}</label>
                <input
                  id="refund-adhoc" inputMode="decimal" value={adhoc} disabled={busy}
                  onChange={(e) => setAdhoc(e.target.value)}
                  style={{ ...formControlStyle, width: 160 }}
                />
                {adhocError && <p role="alert" style={{ margin: '4px 0 0', fontSize: 12, color: '#991b1b' }}>{t(`refund_adhoc_${adhocError}`)}</p>}
              </div>
            )}

            <div style={{ marginBottom: 12 }}>
              <label style={formFieldLabelStyle} htmlFor="refund-method">{t('refund_method')}</label>
              <select id="refund-method" value={method} disabled={busy}
                onChange={(e) => setMethod(e.target.value as RefundMethodCode)} style={{ ...formControlStyle, width: '100%' }}>
                {opts.methods.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
              </select>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
                {t(method === 'provider' ? 'refund_method_provider_help' : 'refund_method_manual_help')}
              </p>
            </div>

            <p style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
              {t('refund_final_amount', { amount: amount ? money(amount) : '—' })}
            </p>
          </>
        )}

        {error && <p role="alert" style={{ margin: '0 0 12px', color: '#991b1b', fontSize: 13 }}>{error}</p>}

        <div style={modalActionsRowStyle}>
          <button onClick={accept} disabled={!acceptable} style={{ ...primaryBtnStyle(), opacity: acceptable ? 1 : 0.6 }}>
            {busy ? t('modal_working') : t('modal_accept')}
          </button>
          <button onClick={dismiss} disabled={busy} style={secondaryBtnStyle}>{t('refund_cancel')}</button>
        </div>
      </div>
    </div>
  );
}
