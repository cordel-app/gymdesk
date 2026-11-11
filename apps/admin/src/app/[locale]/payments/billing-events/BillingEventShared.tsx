'use client';

// #2571 — the Billing Event *header* and its payment actions, shared by
// Payments → Billing Events (a table row) and the Member card's Payments tab
// (a card), the way `ExpandedRow` already is (#2449). Neither surface keeps a
// copy of the status labels, the per-action flags or the Pay Cash / Pay Card /
// Retry / Waive flow: whether an action is offered is the API's flag.

import React, { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenuItem } from '@/components/ContextMenu';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { StatusBadge, fmtAmount } from './BillingEventExpandedRow';
import { PaymentActionModal } from './PaymentActionModal';
import { PaymentActionKind, actionRequest } from './paymentActions';

type T = ReturnType<typeof useTranslations>;

export const BILLING_EVENT_STATUS_VALUES = ['paid', 'failed', 'pending', 'scheduled', 'recorded'] as const;

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

  const closePending = useCallback(() => setPending(null), []);

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
    // flags say they don't apply. There is deliberately no Cancel item: closing
    // a confirmation never alters the outstanding obligation (#1459 §2).
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
    if (row.can_waive) {
      items.push({ label: t('billing_events_page.action_waive'), onClick: () => openAction('waive', row), disabled: !canWrite, title: readOnlyTitle, danger: true });
    }
    return items;
  }

  const modal = pending ? (
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

  return { menuItems, modal, closePending, canWrite, readOnlyTitle };
}
