'use client';

// #2571 — the Billing Event *header* and its payment actions, shared by
// Payments → Billing Events (a table row) and the Member card's Payments tab
// (the same table since the #2449 follow-up), the way `ExpandedRow` already is (#2449). Neither surface keeps a
// copy of the status labels, the per-action flags or the Pay Cash / Pay Card /
// Retry / Waive flow: whether an action is offered is the API's flag.

import React, { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { ExpandedRow, StatusBadge, fmtAmount, fmtDate, fmtDateTime } from './BillingEventExpandedRow';
import type { GymFormatSettings } from '@/lib/gymFormat';
import { PaymentActionModal } from './PaymentActionModal';
import { PaymentActionKind, actionRequest } from './paymentActions';
import { RefundModal } from './RefundModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';

type T = ReturnType<typeof useTranslations>;

export const BILLING_EVENT_STATUS_VALUES = ['paid', 'failed', 'pending', 'scheduled', 'recorded', 'cancelled'] as const;

/** The fields of a list row the header and the actions read. */
export interface BillingEventHeaderRow {
  id: number | null;
  member_name?: string | null;
  user_membership_id?: number | null;
  amount: string | null;
  currency?: string | null;
  event_type: string;
  status: string;
  normalized_payment_status?: string | null;
  can_retry?: boolean;
  can_pay_cash?: boolean;
  can_pay_card?: boolean;
  can_waive?: boolean;
  first_payment?: boolean;
  /** #2480: the latest attempt's payment method snapshot and the event's own attempt counter. */
  payment_method_name?: string | null;
  attempt_count?: number;
  /** #2480: the API's flags for Cancel (pending only) and Refund (admin, flag on, money left to return). */
  can_cancel?: boolean;
  can_refund?: boolean;
  refunded_amount?: string | null;
  refund_state?: string | null;
}

/** The fields a row of the shared Billing Events table reads. */
export interface BillingEventsTableRow extends BillingEventHeaderRow {
  type?: 'real' | 'virtual';
  plan_name?: string | null;
  billing_date: string;
  created_at: string | null;
}

/** Columns of the shared table; the expanded row spans them all. */
export const BILLING_EVENTS_TABLE_COLUMNS = 11;

/**
 * #2449 follow-up: the Billing Events **table** — header, rows, chevron and
 * the expanded `ExpandedRow` — shared by Payments → Billing Events and the
 * Member card's Payments tab, so both show the same columns under the same
 * header. Presentational: the rows, the expansion state, the actions and the
 * reload are the host's.
 */
export function BillingEventsTable<R extends BillingEventsTableRow>({
  rows, gym, t, expanded, onToggle, menuItems, onChanged, canWrite, readOnlyTitle, emptyLabel,
}: {
  rows: R[];
  gym: GymFormatSettings;
  t: T;
  expanded: Set<number>;
  onToggle: (id: number) => void;
  menuItems: (row: R) => ContextMenuItem[];
  onChanged: () => void;
  canWrite: boolean;
  readOnlyTitle?: string;
  emptyLabel: string;
}) {
  const th: React.CSSProperties = { padding: '8px 12px' };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ ...th, width: 32 }} />
            <th style={th}>{t('billing_events_page.col_member')}</th>
            <th style={th}>{t('billing_events_page.col_plan')}</th>
            <th style={th}>{t('billing_events_page.header_method')}</th>
            <th style={{ ...th, textAlign: 'right' }}>{t('billing_events_page.header_attempts')}</th>
            <th style={th}>{t('billing_events_page.col_date')}</th>
            <th style={th}>{t('billing_events_page.col_created')}</th>
            <th style={{ ...th, textAlign: 'right' }}>{t('billing_events_page.col_amount')}</th>
            <th style={th}>{t('billing_events_page.col_status')}</th>
            <th style={th}>{t('billing_events_page.col_normalized_payment_status')}</th>
            <th style={{ ...th, width: 48 }}>{t('billing_events_page.col_actions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={BILLING_EVENTS_TABLE_COLUMNS} style={{ padding: '24px 12px', textAlign: 'center', color: '#888' }}>
                {emptyLabel}
              </td>
            </tr>
          )}
          {rows.map((row, idx) => {
            const rowKey = row.id != null ? `real-${row.id}` : `virtual-${row.user_membership_id}-${row.billing_date}-${idx}`;
            const isExpandable = row.type !== 'virtual' && row.id != null;
            const isExpanded = isExpandable && expanded.has(row.id!);
            return (
              <React.Fragment key={rowKey}>
                <tr
                  style={{
                    borderBottom: isExpanded ? 'none' : '1px solid #f3f4f6',
                    background: isExpanded ? '#f9fafb' : undefined,
                    cursor: isExpandable ? 'pointer' : undefined,
                  }}
                  onClick={isExpandable ? () => onToggle(row.id!) : undefined}
                  aria-expanded={isExpandable ? isExpanded : undefined}
                >
                  <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 12 }}>
                    {isExpandable ? (isExpanded ? '▾' : '▸') : null}
                  </td>
                  <td style={{ padding: '8px 12px', fontWeight: 500 }}>{row.member_name ?? '—'}</td>
                  <td style={{ padding: '8px 12px', color: '#6b7280' }}>{row.plan_name ?? '—'}</td>
                  <td style={{ padding: '8px 12px' }}>{row.payment_method_name ?? '—'}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.attempt_count ?? 0}</td>
                  <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{fmtDate(row.billing_date, gym)}</td>
                  <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtDateTime(row.created_at, gym)}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {billingEventAmountLabel(row)}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <BillingEventStatusBadge row={row} t={t} />
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <NormalizedPaymentStatusBadge status={row.normalized_payment_status} t={t} />
                  </td>
                  <td style={{ padding: '8px 12px' }} onClick={(e) => e.stopPropagation()}>
                    {isExpandable && (
                      <ContextMenu items={menuItems(row)} ariaLabel={t('billing_events_page.col_actions')} />
                    )}
                  </td>
                </tr>
                {isExpanded && row.id != null && (
                  <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                    <ExpandedRow
                      key={`${row.id}-${row.status}-${row.refunded_amount ?? ''}`}
                      billingEvent={row}
                      onChanged={onChanged}
                      canWrite={canWrite}
                      readOnlyTitle={readOnlyTitle}
                      t={t}
                    />
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface RetryResult {
  new_status: string;
  attempts: { attempt: number; status: string }[];
  membership_paused: boolean;
}

/** The label of an event's status badge (a waived event reads *Waived*). */
export function billingEventStatusLabel(row: Pick<BillingEventHeaderRow, 'status' | 'event_type'>, t: T): string {
  if (row.event_type === 'waived_billing') return t('billing_events_page.status_waived');
  return (BILLING_EVENT_STATUS_VALUES as readonly string[]).includes(row.status)
    ? t(`billing_events_page.status_${row.status}` as any)
    : row.status;
}

export function BillingEventStatusBadge({ row, t }: { row: Pick<BillingEventHeaderRow, 'status' | 'event_type'>; t: T }) {
  return <StatusBadge status={row.status} label={billingEventStatusLabel(row, t)} />;
}

/** The latest attempt's normalized payment status; `—` when the event has none. */
export function NormalizedPaymentStatusBadge({ status, t }: { status: string | null | undefined; t: T }) {
  if (!status) return <>—</>;
  const tone = status === 'completed' ? 'paid' : status === 'pending' ? 'pending' : 'failed';
  return <StatusBadge status={tone} label={t(`billing_events_page.normalized_${status}` as any)} />;
}

export function billingEventAmountLabel(row: Pick<BillingEventHeaderRow, 'amount' | 'currency'>): string {
  return `${fmtAmount(row.amount)} ${row.currency ?? ''}`.trim();
}

/**
 * The Pay Cash / Pay Card / Retry / Waive flow. `openDetails` and `onChanged`
 * are the host's: expand the event, re-read the list.
 */
export function useBillingEventActions<R extends BillingEventHeaderRow>(opts: {
  onChanged: () => void;
  openDetails: (id: number) => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const { canWrite, readOnlyTitle } = useModuleAccess('PAYMENTS');
  const { onChanged, openDetails } = opts;

  /** #1459: the confirmation open for a Pay Cash / Pay Card / Waive (at most one). */
  const [pending, setPending] = useState<{ kind: PaymentActionKind; row: R } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  /** #2480: the event a Cancel confirmation or the Refund modal is open for. */
  const [cancelling, setCancelling] = useState<R | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [refunding, setRefunding] = useState<R | null>(null);

  const closePending = useCallback(() => setPending(null), []);

  /** #2480: Cancel is a backend operation; the dialog's own Cancel changes nothing. */
  async function confirmCancel() {
    if (!cancelling || cancelBusy) return;
    const id = cancelling.id!;
    setCancelBusy(true);
    try {
      await apiFetch(`/payments/billing-events/${id}/cancel`, { method: 'POST' });
      toast(t('billing_events_page.cancel_success'), 'success');
      setCancelling(null);
      openDetails(id);
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('billing_events_page.action_error'));
    } finally {
      setCancelBusy(false);
    }
  }

  function openAction(kind: PaymentActionKind, row: R) {
    setActionError(null);
    setPending({ kind, row });
  }

  /**
   * #640 §3: one click fires the provider charge and, on rejection, once more
   * (server-side). Two rejections pause the assigned plan, which the toast
   * says explicitly — it is a status change the admin did not ask for.
   */
  async function retryPayment(id: number) {
    setRetryingId(id);
    try {
      const result = await apiFetch<RetryResult>(`/payments/billing-events/${id}/retry`, { method: 'POST' });
      if (result.new_status === 'paid') {
        toast(t('billing_events_page.retry_success'), 'success');
      } else if (result.membership_paused) {
        toast(t('billing_events_page.retry_failed_paused', { attempts: result.attempts.length }));
      } else {
        toast(t('billing_events_page.retry_failed', { attempts: result.attempts.length }));
      }
      openDetails(id);
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('billing_events_page.action_error'));
    } finally {
      setRetryingId(null);
    }
  }

  /**
   * #1459: Accept is the only thing that records anything. The request is the
   * server's to authorise and to refuse a second time (409); the busy flag only
   * keeps this client from sending it twice.
   */
  async function acceptAction(input: { reason: string }) {
    if (!pending || actionBusy) return;
    const { kind, row } = pending;
    const req = actionRequest(kind, {
      id: row.id!, user_membership_id: row.user_membership_id ?? null, first_payment: row.first_payment,
    }, input);
    setActionBusy(true);
    setActionError(null);
    try {
      await apiFetch(req.path, { method: 'POST', body: JSON.stringify(req.body) });
      toast(t(kind === 'waive' ? 'billing_events_page.waive_success' : 'billing_events_page.manual_success'), 'success');
      setPending(null);
      openDetails(row.id!);
      onChanged();
    } catch (err: any) {
      setActionError(err.message ?? t('billing_events_page.action_error'));
    } finally {
      setActionBusy(false);
    }
  }

  function menuItems(row: R): ContextMenuItem[] {
    const id = row.id!;
    const items: ContextMenuItem[] = [
      { label: t('billing_events_page.action_details'), onClick: () => openDetails(id) },
    ];
    // §1: payment actions are hidden — not merely disabled — where the API's
    // flags say they don't apply. Closing a confirmation never alters the
    // outstanding obligation (#1459 §2); cancelling the *event* is its own
    // backend action, offered only while it is pending (#2480).
    const busy = retryingId === id;
    if (row.can_pay_cash) {
      items.push({ label: t('billing_events_page.action_pay_cash'), onClick: () => openAction('cash', row), disabled: !canWrite, title: readOnlyTitle });
    }
    if (row.can_pay_card) {
      items.push({ label: t('billing_events_page.action_pay_card'), onClick: () => openAction('card', row), disabled: !canWrite, title: readOnlyTitle });
    }
    if (row.can_retry) {
      items.push({
        label: busy ? t('billing_events_page.retry_running') : t('billing_events_page.action_retry'),
        onClick: () => retryPayment(id),
        disabled: !canWrite || busy,
        title: readOnlyTitle,
      });
    }
    if (row.can_refund) {
      items.push({ label: t('billing_events_page.action_refund'), onClick: () => setRefunding(row), disabled: !canWrite, title: readOnlyTitle });
    }
    if (row.can_waive) {
      items.push({ label: t('billing_events_page.action_waive'), onClick: () => openAction('waive', row), disabled: !canWrite, title: readOnlyTitle, danger: true });
    }
    // #2480: Cancel the pending event itself (never a dismissed dialog).
    if (row.can_cancel) {
      items.push({ label: t('billing_events_page.action_cancel_event'), onClick: () => setCancelling(row), disabled: !canWrite, title: readOnlyTitle, danger: true });
    }
    return items;
  }

  const extraModals = (
    <>
      <ConfirmDialog
        open={cancelling != null}
        title={t('billing_events_page.cancel_modal_title')}
        message={t('billing_events_page.cancel_modal_body', {
          member: cancelling?.member_name ?? '—',
          amount: cancelling ? `${fmtAmount(cancelling.amount)} ${cancelling.currency ?? 'EUR'}` : '',
        })}
        confirmLabel={cancelBusy ? t('billing_events_page.modal_working') : t('billing_events_page.cancel_modal_confirm')}
        cancelLabel={t('billing_events_page.modal_close')}
        onConfirm={confirmCancel}
        onCancel={() => { if (!cancelBusy) setCancelling(null); }}
        busy={cancelBusy}
      />
      {refunding && (
        <RefundModal
          billingEventId={refunding.id!}
          memberName={refunding.member_name ?? '—'}
          currency={refunding.currency ?? 'EUR'}
          onClose={() => setRefunding(null)}
          onDone={(r) => {
            const id = refunding.id!;
            toast(t(r.status === 'pending' ? 'billing_events_page.refund_pending' : 'billing_events_page.refund_success', { amount: fmtAmount(r.amount) }), 'success');
            setRefunding(null);
            openDetails(id);
            onChanged();
          }}
        />
      )}
    </>
  );

  const paymentModal = pending ? (
    <PaymentActionModal
      kind={pending.kind}
      memberName={pending.row.member_name ?? '—'}
      amountLabel={`${fmtAmount(pending.row.amount)} ${pending.row.currency ?? 'EUR'}`}
      busy={actionBusy}
      error={actionError}
      onAccept={acceptAction}
      onClose={closePending}
    />
  ) : null;

  const modal = <>{paymentModal}{extraModals}</>;

  return { menuItems, modal, closePending, canWrite, readOnlyTitle };
}
