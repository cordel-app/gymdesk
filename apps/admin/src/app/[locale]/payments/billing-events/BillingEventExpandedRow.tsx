'use client';

// Shared Billing Event renderer: used by Payments → Billing Events and by the
// Member card's Payments tab (#2449) so both show the same details, lines and
// payment transactions from one implementation.

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { useToast } from '@/components/Toast';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDate, formatGymDateTime, formatGymDateOnly, type GymFormatSettings } from '@/lib/gymFormat';
import { readOnlyStyle } from '@/components/ui';

export interface Transaction {
  id: number;
  status: string;
  amount: string | null;
  currency: string | null;
  provider: string | null;
  provider_ref: string | null;
  source: string | null;
  attempt: number | null;
  payment_method_name?: string | null;
  failure_code: string | null;
  failure_message: string | null;
  notes: string | null;
  created_at: string;
  completed_at: string | null;
  member_name: string | null;
  plan_name: string | null;
  card_brand: string | null;
  card_last4: string | null;
  provider_status?: string | null;
  normalized_payment_status?: string | null;
  /** #2480: `refund` rows return money of the attempt they name. */
  transaction_type?: 'payment' | 'refund';
  refund_of_payment_request_id?: number | null;
  provider_refund_ref?: string | null;
}

export /** #640 §2 — the read-only Billing Event details view. */
interface BillingEventDetails {
  id: number;
  member_id: number | null;
  member_name: string | null;
  user_membership_id: number | null;
  plan_name: string | null;
  amount: string | null;
  currency: string | null;
  status: string;
  payment_status?: string | null;
  normalized_payment_status?: string | null;
  event_type: string;
  charge_type_code: string | null;
  source: string | null;
  notes: string | null;
  receipt_number: string | null;
  created_at: string;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
  failure_reason: string | null;
  /** #1474: the event's priced components, read-only. */
  lines?: { id: number; kind: string; item_name: string; quantity: number; unit_amount: string | null; promotion_name: string | null; amount: string | null }[];
  can_retry: boolean;
  can_record_manual_payment: boolean;
  /** #787: the event represents money received, so a receipt may be issued for it. */
  can_issue_receipt: boolean;
}


// billing_date is a calendar day (not an instant), so it is not zone-shifted.
export function fmtDate(iso: string, s: GymFormatSettings) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? formatGymDateOnly(iso, s) : formatGymDate(iso, s);
}

/** #639: an instant (billing_events.created_at) in the gym's date/time format and zone. */
export function fmtDateTime(iso: string | null, s: GymFormatSettings) {
  if (!iso) return '—';
  return formatGymDateTime(iso, s);
}

/**
 * #639: `user_memberships.next_billing_date` is a DATE column — the billing run
 * stores the day, not a time of day — so the scheduled day is rendered verbatim
 * at 00:00 rather than parsed as an instant and shifted by the viewer's timezone.
 */
export function fmtScheduledDate(date: string | null, s: GymFormatSettings) {
  if (!date) return '—';
  const day = formatGymDateOnly(date, s);
  if (day === '—') return '—';
  return `${day} ${s.time_format === '12h' ? '12:00 AM' : '00:00'}`;
}

export function fmtAmount(amount: string | null) {
  if (!amount) return '—';
  const n = parseFloat(amount);
  return isNaN(n) ? '—' : n.toFixed(2);
}


// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  paid:      { bg: '#dcfce7', text: '#166534' },
  failed:    { bg: '#fee2e2', text: '#991b1b' },
  pending:   { bg: '#ffedd5', text: '#9a3412' },
  scheduled: { bg: '#fef9c3', text: '#92400e' },
  recorded:  { bg: '#e0f2fe', text: '#075985' },
  cancelled: { bg: '#f3f4f6', text: '#374151' },
};

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const c = STATUS_COLORS[status] ?? { bg: '#f3f4f6', text: '#374151' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 12,
      fontSize: 12, fontWeight: 600, background: c.bg, color: c.text,
    }}>
      {label}
    </span>
  );
}

// ── Expanded row: Details + Manual payment card + Transactions ────────────────

const detailLabelStyle: React.CSSProperties = { color: '#6b7280', fontSize: 12 };
const detailValueStyle: React.CSSProperties = { fontSize: 13, fontWeight: 500 };

function CollapsibleSection({ title, defaultOpen, children }: { title: string; defaultOpen: boolean; children: React.ReactNode }) {
  // #2451: Transaction Details and Payment Transactions start collapsed, Billing Event Lines expanded.
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, margin: '0 0 8px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && children}
    </div>
  );
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={detailLabelStyle}>{label}</div>
      <div style={detailValueStyle}>{children}</div>
    </div>
  );
}

/**
 * #640: one expanded component per row serving both `Details` (read-only) and
 * the inline Manual payment card — the Inline row CRUD rule in
 * docs/feature-patterns.md, so Details never becomes a second surface to keep
 * in sync. `refreshToken` re-fetches after an action changes the event.
 */
export function ExpandedRow({
  billingEvent,
  onChanged,
  canWrite,
  readOnlyTitle,
  t,
  asCell = true,
}: {
  billingEvent: { id: number | null };
  onChanged: () => void;
  canWrite: boolean;
  readOnlyTitle?: string;
  t: ReturnType<typeof useTranslations>;
  /** false: render a plain block (Member card) instead of a table cell. */
  asCell?: boolean;
}) {
  const billingEventId = billingEvent.id!;
  const gymFmt = useGymFormatSettings();
  const { apiFetch, pdfFetch } = useApiClient();
  const { toast } = useToast();
  const [details, setDetails] = useState<BillingEventDetails | null>(null);
  const [rows, setRows] = useState<Transaction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [receiptBusy, setReceiptBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, tx] = await Promise.all([
        apiFetch<BillingEventDetails>(`/payments/billing-events/${billingEventId}`),
        apiFetch<{ items: Transaction[] }>(`/payments/billing-events/${billingEventId}/transactions`),
      ]);
      setDetails(d);
      setRows(tx.items);
    } catch {
      setDetails(null);
      setRows([]);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingEventId]);

  useEffect(() => { load(); }, [load]);

  /**
   * #787: one button for both halves of the receipt. A `POST` issues the
   * number on first use and returns the PDF; once the event carries a number
   * there is nothing to allocate, so a `GET` fetches the same PDF without a
   * write — which is what lets a read-only PAYMENTS role still open it.
   */
  async function openReceipt() {
    if (!details) return;
    const alreadyIssued = !!details.receipt_number;
    setReceiptBusy(true);
    try {
      const blob = await pdfFetch(`/payments/${billingEventId}/receipt`, alreadyIssued ? 'GET' : 'POST');
      window.open(URL.createObjectURL(blob), '_blank');
      if (!alreadyIssued) {
        await load();
        onChanged();
      }
    } catch (err: any) {
      toast(err.message ?? t('billing_events_page.action_error'));
    } finally {
      setReceiptBusy(false);
    }
  }

  if (loading) {
    return asCell ? (
      <td colSpan={11} style={{ padding: '12px 16px', fontSize: 13, color: '#6b7280' }}>
        {t('billing_events_page.loading')}
      </td>
    ) : (
      <div style={{ padding: '12px 16px', fontSize: 13, color: '#6b7280' }}>{t('billing_events_page.loading')}</div>
    );
  }

  const body = (
      <div style={{ padding: '12px 16px 16px' }}>
        {/* ── Details (read-only) ── */}
        {details && (
          <CollapsibleSection title={t('billing_events_page.details_heading')} defaultOpen={false}>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 10, marginBottom: 16,
            }}>
              <DetailField label={t('billing_events_page.det_id')}>{details.id}</DetailField>
              <DetailField label={t('billing_events_page.det_member')}>{details.member_name ?? '—'}</DetailField>
              <DetailField label={t('billing_events_page.det_plan')}>{details.plan_name ?? '—'}</DetailField>
              <DetailField label={t('billing_events_page.det_amount')}>
                {fmtAmount(details.amount)} {details.currency ?? ''}
              </DetailField>
              <DetailField label={t('billing_events_page.det_status')}>
                <StatusBadge
                  status={details.status}
                  label={details.event_type === 'waived_billing'
                    ? t('billing_events_page.status_waived')
                    : t(`billing_events_page.status_${details.status}` as any)}
                />
              </DetailField>
              <DetailField label={t('billing_events_page.det_normalized_payment_status')}>
                {details.normalized_payment_status
                  ? <StatusBadge status={details.normalized_payment_status === 'completed' ? 'paid' : details.normalized_payment_status === 'pending' ? 'pending' : 'failed'} label={t(`billing_events_page.normalized_${details.normalized_payment_status}` as any)} />
                  : '—'}
              </DetailField>
              <DetailField label={t('billing_events_page.det_payment_status')}>
                {details.payment_status ?? '—'}
              </DetailField>
              <DetailField label={t('billing_events_page.det_event_type')}>{details.event_type}</DetailField>
              <DetailField label={t('billing_events_page.det_charge_type')}>{details.charge_type_code ?? '—'}</DetailField>
              <DetailField label={t('billing_events_page.det_source')}>{details.source ?? '—'}</DetailField>
              <DetailField label={t('billing_events_page.det_created_at')}>{fmtDateTime(details.created_at, gymFmt)}</DetailField>
              <DetailField label={t('billing_events_page.det_created_by')}>
                {details.created_by ?? t('billing_events_page.actor_system')}
              </DetailField>
              <DetailField label={t('billing_events_page.det_modified_at')}>{fmtDateTime(details.modified_at, gymFmt)}</DetailField>
              <DetailField label={t('billing_events_page.det_modified_by')}>{details.modified_by ?? '—'}</DetailField>
              <DetailField label={t('billing_events_page.det_receipt')}>{details.receipt_number ?? '—'}</DetailField>
              {details.failure_reason && (
                <DetailField label={t('billing_events_page.det_failure_reason')}>
                  <span style={{ color: '#991b1b' }}>{details.failure_reason}</span>
                </DetailField>
              )}
              {details.notes && (
                <DetailField label={t('billing_events_page.det_notes')}>{details.notes}</DetailField>
              )}
            </div>
            {/* #675: same deep link every Details view offers — filtered to this event. */}
            <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
              <ViewAuditLogButton entityType="billing_event" entityId={details.id} size="small" />
              {/* #787: issuing allocates a number, so it needs write access;
                  downloading one already issued does not. */}
              {details.can_issue_receipt && (
                <button
                  onClick={openReceipt}
                  disabled={receiptBusy || (!details.receipt_number && !canWrite)}
                  title={details.receipt_number ? undefined : readOnlyTitle}
                  style={readOnlyStyle({
                    padding: '4px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 6,
                    border: '1px solid #166534', background: '#fff', color: '#166534', fontWeight: 600,
                  }, receiptBusy || (!details.receipt_number && !canWrite))}
                >
                  {receiptBusy
                    ? t('billing_events_page.receipt_working')
                    : details.receipt_number
                    ? `${t('billing_events_page.receipt_download')} (${details.receipt_number})`
                    : t('billing_events_page.receipt_issue')}
                </button>
              )}
            </div>
          </CollapsibleSection>
        )}

        {/* ── Billing event lines (#1474, read-only) ── */}
        {details?.lines && details.lines.length > 0 && (
          <CollapsibleSection title={t('billing_events_page.lines_heading')} defaultOpen>
            <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%', marginBottom: 16 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                  {(['col_line_item', 'col_line_quantity', 'col_line_unit', 'col_line_total'] as const).map((k) => (
                    <th key={k} style={{ padding: '4px 10px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>
                      {t(`billing_events_page.${k}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {details.lines.map((l) => (
                  <tr key={l.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '6px 10px' }}>
                      {l.item_name}
                      {l.promotion_name && <span style={{ color: '#6b7280' }}> ({l.promotion_name})</span>}
                    </td>
                    <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums' }}>{l.quantity}</td>
                    <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums' }}>
                      {l.unit_amount != null ? `${fmtAmount(l.unit_amount)} ${details.currency ?? ''}` : '—'}
                    </td>
                    <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums' }}>
                      {l.amount != null ? `${fmtAmount(l.amount)} ${details.currency ?? ''}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CollapsibleSection>
        )}

        {/* ── Payment transactions ── */}
        <CollapsibleSection title={t('billing_events_page.transactions_heading')} defaultOpen={false}>
        {rows && rows.length === 0 ? (
          <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>{t('billing_events_page.transactions_empty')}</p>
        ) : (
          <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                {(['col_tx_date', 'col_tx_status', 'col_tx_provider_status', 'col_tx_amount', 'col_tx_source', 'col_tx_attempt', 'col_tx_method', 'col_tx_card', 'col_tx_ref', 'col_tx_reason'] as const).map((k) => (
                  <th key={k} style={{ padding: '4px 10px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>
                    {t(`billing_events_page.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows?.map((tx) => (
                <tr key={tx.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{fmtDate(tx.created_at, gymFmt)}</td>
                  <td style={{ padding: '6px 10px' }}>
                    {tx.transaction_type === 'refund' && (
                      <span style={{ marginRight: 6, padding: '1px 6px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: '#ede9fe', color: '#5b21b6' }}>
                        {t('billing_events_page.tx_refund')}
                      </span>
                    )}
                    {tx.status}
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    {tx.provider_status ?? '—'}{tx.normalized_payment_status ? ` (${tx.normalized_payment_status})` : ''}
                  </td>
                  <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums' }}>
                    {tx.transaction_type === 'refund' ? '−' : ''}{fmtAmount(tx.amount)} {tx.currency ?? ''}
                  </td>
                  <td style={{ padding: '6px 10px' }}>{tx.source ?? '—'}</td>
                  <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums' }}>{tx.transaction_type === 'refund' ? '—' : (tx.attempt ?? '—')}</td>
                  <td style={{ padding: '6px 10px' }}>{tx.payment_method_name ?? '—'}</td>
                  <td style={{ padding: '6px 10px' }}>
                    {tx.card_brand && tx.card_last4 ? `${tx.card_brand} ···${tx.card_last4}` : '—'}
                  </td>
                  <td style={{ padding: '6px 10px', color: '#6b7280', fontFamily: 'monospace', fontSize: 12 }}>
                    {(tx.transaction_type === 'refund' ? tx.provider_refund_ref : tx.provider_ref) ?? '—'}
                  </td>
                  <td style={{ padding: '6px 10px', color: tx.failure_code ? '#991b1b' : '#6b7280' }}>
                    {[tx.failure_code, tx.failure_message].filter(Boolean).join(': ') || tx.notes || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        </CollapsibleSection>
      </div>
  );
  return asCell ? <td colSpan={11} style={{ padding: '0 0 0 48px', background: '#f9fafb' }}>{body}</td> : body;
}

