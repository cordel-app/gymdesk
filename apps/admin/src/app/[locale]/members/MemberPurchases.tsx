'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymAmount, formatGymDateTime } from '@/lib/gymFormat';
import {
  cardDetailLabelStyle, cardDetailRowStyle, cardDetailValueStyle,
  cardMutedTextStyle, cardSubLabelStyle, cardTextLinkStyle, formErrorStyle,
} from '@/components/formChrome';
import { DataTable, type Column } from '@/components/DataTable';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { CrudModal } from '@/components/CrudModal';
import { CardDetailRow } from '@/components/CardDetailRow';
import { StatusBadge } from '@/components/StatusBadge';
import { purchaseStatusKey } from '@/lib/purchaseName';
import { NormalizedPaymentStatusBadge, BillingEventStatusBadge } from '../payments/billing-events/BillingEventShared';
import {
  beneficiaryNameIfOther, otherBeneficiaryNames, productTypeLabelKey, purchaseChannelLabelKey, purchaseDisplayName,
  purchaseCancelErrorKey, purchaseCanCancel, purchaseEventPath, purchaseIsEmpty, purchaseTotalValue, type MemberPurchase, type PurchaseBillingEvent,
} from './purchasesTabView';

/**
 * #3273 — the Member card's **Purchases** tab: one row per `purchases` row the Member owns or
 * benefits from (`GET /payments/purchases?member_id=`), newest first. #3355 stage 2 draws it as the
 * standard list (`DataTable`, as the Products section is): Purchase · Created By · Created At ·
 * Modified At · Total Amount · Status · `⋮`, each row expanding into the plans it contracted (with
 * their included Products beneath them), its standalone Products and the payment of its own
 * Billing Event; `⋮ → Details` opens the purchase record. Every value is the API's; this draws.
 */
export function MemberPurchases({ memberId }: { memberId: number | string }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [items, setItems] = useState<MemberPurchase[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Set<React.Key>>(new Set());
  const [detail, setDetail] = useState<MemberPurchase | null>(null);
  // #3355 stage 3: `⋮ → Cancel` of a purchase awaiting payment, confirmed first.
  const { canWrite, readOnlyTitle } = useModuleAccess('PAYMENTS');
  const [cancelling, setCancelling] = useState<MemberPurchase | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch<{ items: MemberPurchase[] }>(`/payments/purchases?member_id=${memberId}&limit=200`)
      .then((r) => { setItems(r.items ?? []); setFailed(false); })
      .catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);
  useEffect(() => { load(); }, [load]);

  const confirmCancel = async () => {
    if (!cancelling) return;
    setCancelBusy(true);
    setCancelError(null);
    try {
      await apiFetch(`/payments/purchases/${cancelling.id}/cancel`, { method: 'POST' });
      setCancelling(null);
      load();
    } catch (err: any) {
      setCancelError(t(purchaseCancelErrorKey(err?.body?.error ?? err?.code) as any));
      setCancelling(null);
      load();
    } finally {
      setCancelBusy(false);
    }
  };

  if (failed) return <p style={formErrorStyle}>{t('members.purchases_error')}</p>;

  const toggle = (p: MemberPurchase) => setOpen((prev) => {
    const n = new Set(prev); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n;
  });
  const dash = '—';
  const when = (v: string | null) => (v ? formatGymDateTime(v, gym) : dash);
  const total = (p: MemberPurchase) => { const v = purchaseTotalValue(p); return v == null ? dash : formatGymAmount(v, gym); };
  const status = (p: MemberPurchase) => {
    const key = purchaseStatusKey(p.status);
    return <StatusBadge status={p.status} label={key ? t(`members.${key}` as any) : p.status} />;
  };

  const columns: Column<MemberPurchase>[] = [
    {
      key: 'purchase', header: t('members.purchases_col_purchase'), mobile: 'name',
      title: (p) => purchaseDisplayName(p),
      render: (p) => <strong data-purchase-name>{purchaseDisplayName(p)}</strong>,
    },
    { key: 'created_by', mobile: 'secondary', header: t('members.purchases_col_created_by'), render: (p) => p.created_by ?? dash },
    { key: 'created_at', mobile: 'secondary', header: t('members.purchases_col_created_at'), render: (p) => when(p.created_at) },
    { key: 'modified_at', mobile: 'secondary', header: t('members.purchases_col_modified_at'), render: (p) => when(p.modified_at) },
    { key: 'total', mobile: 'secondary', header: t('members.purchases_col_total'), render: (p) => <span style={{ whiteSpace: 'nowrap' }}>{total(p)}</span> },
    { key: 'status', header: t('members.purchases_col_status'), mobile: 'keep', render: (p) => <span data-purchase-status={p.status}>{status(p)}</span> },
    {
      key: 'actions', header: '', width: 48, mobile: 'actions',
      render: (p) => (
        <ContextMenu
          ariaLabel={t('members.purchases_actions_for', { purchase: purchaseDisplayName(p) })}
          items={[
            ...(purchaseCanCancel(p) ? [{
              label: t('members.purchases_action_cancel'), danger: true, disabled: !canWrite, title: readOnlyTitle,
              onClick: () => { setCancelError(null); setCancelling(p); },
            } as ContextMenuItem] : []),
            { kind: 'details' as const, label: t('members.action_details'), onClick: () => setDetail(p) },
          ]}
        />
      ),
    },
  ];

  return (
    <div>
      {cancelError && <p role="alert" style={formErrorStyle}>{cancelError}</p>}
      <DataTable
        columns={columns}
        rows={items ?? []}
        rowKey={(p) => p.id}
        loading={items === null}
        loadingText={t('members.purchases_loading')}
        emptyText={t('members.purchases_empty')}
        expandedRowKeys={open}
        onToggleExpand={toggle}
        clickRowToExpand
        renderExpanded={(p) => <PurchaseDetailBody p={p} />}
      />
      <ConfirmDialog
        open={cancelling !== null}
        title={t('members.purchases_cancel_title')}
        message={t('members.purchases_cancel_message', { purchase: cancelling ? purchaseDisplayName(cancelling) : '' })}
        busy={cancelBusy}
        confirmLabel={t('members.purchases_cancel_confirm')}
        cancelLabel={t('members.purchases_cancel_keep')}
        onConfirm={confirmCancel}
        onCancel={() => setCancelling(null)}
      />
      <CrudModal
        open={detail !== null}
        title={detail ? purchaseDisplayName(detail) : ''}
        hideSave
        cancelLabel={t('members.close')}
        saveLabel=""
        onCancel={() => setDetail(null)}
        onSave={() => setDetail(null)}
      >
        {detail && <PurchaseRecord p={detail} t={t} when={when} total={total} status={status} />}
      </CrudModal>
    </div>
  );
}

/**
 * #3307 stage 4 — a purchase's contents and the payment of its own Billing Events: the Purchases
 * tab's expanded row, and the Products Summary's detail of the cart Save & Pay submitted.
 */
export function PurchaseDetailBody({ p }: { p: MemberPurchase }) {
  const t = useTranslations();
  const locale = useLocale();
  const gym = useGymFormatSettings();
  const dash = '—';
  const typeLabel = (type: string | null) => { const k = productTypeLabelKey(type); return k ? t(k as any) : (type ?? ''); };
  const forName = (name: string | null) => (name ? ` · ${t('members.purchases_for', { name })}` : '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 16px 12px' }}>
      {p.plans.length > 0 && (
        <div>
          <div style={cardSubLabelStyle}>{t('members.purchases_plans')}</div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {p.plans.map((plan) => {
              const others = otherBeneficiaryNames(plan, p.owner);
              return (
                <li key={plan.plan_snapshot_id}>
                  {plan.name ?? `#${plan.membership_plan_id ?? plan.plan_snapshot_id}`}
                  {others.length > 0 && <span style={cardMutedTextStyle}>{forName(others.join(', '))}</span>}
                  {plan.products.length > 0 && (
                    <ul style={{ margin: '2px 0', paddingLeft: 18 }}>
                      {plan.products.map((line, i) => (
                        <li key={`${line.kind}-${line.product_id}-${i}`} style={cardMutedTextStyle}>
                          {line.name ?? dash} · {typeLabel(line.product_type)} · ×{line.quantity}
                          {forName(beneficiaryNameIfOther(line.beneficiary, p.owner))}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {p.products.length > 0 && (
        <div>
          <div style={cardSubLabelStyle}>{t('members.purchases_products')}</div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {p.products.map((line, i) => (
              <li key={`${line.kind}-${line.line_id}-${i}`}>
                {line.name ?? dash} <span style={cardMutedTextStyle}>· {typeLabel(line.product_type)} · ×{line.quantity}
                  {forName(beneficiaryNameIfOther(line.beneficiary, p.owner))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {purchaseIsEmpty(p) && <p style={cardMutedTextStyle}>{t('members.purchases_no_items')}</p>}

      <div>
        <div style={cardSubLabelStyle}>{t('members.purchases_payment')}</div>
        {p.billing_events.length === 0
          ? <p style={cardMutedTextStyle}>{t('members.purchases_not_paid')}</p>
          : p.billing_events.map((e) => (
            <PaymentDetails key={e.id} event={e} locale={locale} gym={gym} t={t} />
          ))}
      </div>
    </div>
  );
}

/**
 * `⋮ → Details`: the purchase record itself (#3278's Managed by and Channel moved here from the
 * expanded row, which keeps the purchase's contents and payment).
 */
function PurchaseRecord({ p, t, when, total, status }: {
  p: MemberPurchase; t: ReturnType<typeof useTranslations>;
  when: (v: string | null) => string; total: (p: MemberPurchase) => string; status: (p: MemberPurchase) => React.ReactNode;
}) {
  const channelKey = purchaseChannelLabelKey(p.channel);
  const dash = '—';
  return (
    <div style={{ padding: '8px 0' }}>
      <CardDetailRow label={t('members.purchases_col_purchase')} value={purchaseDisplayName(p)} />
      <CardDetailRow label={t('members.purchases_details_id')} value={`#${p.id}`} />
      <CardDetailRow label={t('members.purchases_col_status')} value={status(p)} />
      <CardDetailRow label={t('members.purchases_details_owner')} value={p.owner.name ?? `#${p.owner.id}`} />
      <CardDetailRow label={t('members.purchases_col_total')} value={total(p)} />
      <CardDetailRow label={t('members.purchases_managed_by')} value={p.created_by ?? dash} />
      <CardDetailRow label={t('members.purchases_channel')} value={channelKey ? t(channelKey as any) : dash} />
      <CardDetailRow label={t('members.purchases_col_created_at')} value={when(p.created_at)} />
      <CardDetailRow label={t('members.purchases_details_modified_by')} value={p.modified_by ?? dash} />
      <CardDetailRow label={t('members.purchases_col_modified_at')} value={when(p.modified_at)} />
    </div>
  );
}

function PaymentDetails({ event, locale, gym, t }: {
  event: PurchaseBillingEvent; locale: string; gym: ReturnType<typeof useGymFormatSettings>; t: ReturnType<typeof useTranslations>;
}) {
  const row = (label: string, value: React.ReactNode) => (
    <div style={cardDetailRowStyle}>
      <span style={cardDetailLabelStyle}>{label}</span>
      <span style={cardDetailValueStyle}>{value}</span>
    </div>
  );
  return (
    <div style={{ marginTop: 4 }}>
      {row(t('members.purchases_billing_event'), (
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link href={purchaseEventPath(locale, event.id)} style={cardTextLinkStyle}>
            {event.name ?? t('members.purchases_event_ref', { id: event.id })}
          </Link>
          <BillingEventStatusBadge row={event} t={t as any} />
          {event.amount != null && <span>{formatGymAmount(Number(event.amount), gym)}</span>}
        </span>
      ))}
      {row(t('members.purchases_payment_method'), event.payment_method_name ?? '—')}
      {row(t('members.purchases_payment_status'), <NormalizedPaymentStatusBadge status={event.payment_status} t={t as any} />)}
      {row(t('members.purchases_payment_date'), event.paid_at ? formatGymDateTime(event.paid_at, gym) : '—')}
    </div>
  );
}
