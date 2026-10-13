'use client';

// #1521 — the Member card's **Products** card: the Products this Member
// purchased, as one collapsible card with `+ Add Product` in its header, a list
// of eight columns and a `⋮` per row (Details · View billing event).
//
// What it replaced: #1118 §12's three-column list under *Additional Products*
// and #1463's One-off Products / Current Product Set cards, which showed the
// ProductSet's configuration instead of what was actually bought.
//
// Three of its answers are the rule rather than the implementation.
//
//  - **Everything on screen is the purchase's own frozen copy.** The row comes
//    from `GET /members/:id/products`, which joins neither `products`,
//    `promotions` nor `tax_rates` (#635 §16, §13 of #1118). A value the system
//    never stored — a purchase with no tax rate or no payment request — is
//    `null` and reads `—`; nothing is recalculated or inferred.
//  - **A purchase is never edited.** It is money that moved: the menu carries no
//    edit action. `+ Add Product` opens the inline form (`AddProductPurchase`),
//    which creates a *new* purchase — a pending one-time purchase, or a Draft
//    ProductSet that only Save & Pay activates — and nothing here rewrites one
//    that exists.
//  - **View billing event opens the purchase's own event**, resolved by the
//    API through `payment_request_id → payment_requests.billing_event_id`,
//    never the member's latest event; absent, the action is disabled and says
//    why.
//
// The treatment is read in the Promotion's own voice through
// `benefitTreatmentLabel()` (#896 stage 4), so this surface adds no second
// vocabulary.

import React, { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import { CrudModal } from '@/components/CrudModal';
import { CardDetailRow } from '@/components/CardDetailRow';
import { CardSectionHeader } from '@/components/CardSectionHeader';
import { primaryBtnSmall } from '@/components/ui';
import { formatGymDate, type GymFormatSettings } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { benefitTreatmentLabel } from '@/components/ProductBenefits';
import { cardMutedTextStyle } from '@/components/formChrome';
import { AddProductPurchase } from './AddProductPurchase';
import {
  billingEventPath,
  formatAppliedTax,
  hasBillingEvent,
  paymentStatusKey,
  purchaseDate,
  type PurchasedProduct,
  type PurchasedProductPromotion,
} from './purchasedProductsView';

export type { PurchasedProduct, PurchasedProductPromotion };

export function MemberPurchasedProducts({
  items, memberId, canWrite, canPay, isAdmin, onChanged, onProposal,
}: {
  items: PurchasedProduct[];
  memberId: number;
  /** Members write access: `+ Add Product` is absent without it. */
  canWrite: boolean;
  /** Payments write access: a recurring Product is a ProductSet, committed through Save & Pay. */
  canPay: boolean;
  /** The direct discount is the Admin's alone (the server enforces it too). */
  isAdmin: boolean;
  onChanged: () => void;
  onProposal: (productSetId: number | null) => void;
}) {
  const t = useTranslations('members');
  // The Promotion voice (*Promotion* / *No promotion*), which this namespace
  // does not carry — the labels live where they were written.
  const tp = useTranslations('promotions');
  const locale = useLocale();
  const router = useRouter();
  const gymFmt = useGymFormatSettings();

  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<PurchasedProduct | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  function toggleExpand(item: PurchasedProduct) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
      return next;
    });
  }

  const dash = '—';
  const promotionLabel = (p: PurchasedProductPromotion) => [
    p.promotion_name,
    benefitTreatmentLabel(tp as any, 'promotion', { action: p.benefit_action, value: p.benefit_value } as any),
    // A one-off Product has no billing cycles to express a duration in (#1118
    // `Q5`), so the API answers `null` and the part simply does not appear.
    p.duration_cycles != null ? t('purchase_promotion_cycles', { count: p.duration_cycles }) : null,
  ].filter(Boolean).join(' · ');

  const paymentStatus = (item: PurchasedProduct) => {
    const key = paymentStatusKey(item.payment_status);
    return key
      ? <StatusBadge status={key} label={t(`purchase_payment_status_${key}` as any)} />
      : <span style={cardMutedTextStyle}>{dash}</span>;
  };

  const columns: Column<PurchasedProduct>[] = [
    {
      header: t('purchase_col_product'),
      mobile: 'name',
      title: (item) => item.product_name,
      render: (item) => <div style={{ fontWeight: 500 }}>{item.product_name}</div>,
    },
    {
      header: t('purchase_col_date'),
      mobile: 'secondary',
      render: (item) => (
        <span style={{ whiteSpace: 'nowrap' }}>{date(purchaseDate(item), gymFmt)}</span>
      ),
    },
    {
      header: t('purchase_col_price_incl_vat'),
      mobile: 'secondary',
      render: (item) => <span style={{ whiteSpace: 'nowrap' }}>{money(item.regular_amount, item.currency)}</span>,
    },
    {
      header: t('purchase_col_applied_tax'),
      mobile: 'secondary',
      render: (item) => formatAppliedTax(item.tax_rate_percent) ?? dash,
    },
    {
      header: t('purchase_col_applied_promotion'),
      mobile: 'secondary',
      render: (item) => (item.promotion ? item.promotion.promotion_name : dash),
    },
    {
      header: t('purchase_col_final_price'),
      mobile: 'secondary',
      render: (item) => <span style={{ whiteSpace: 'nowrap' }}>{money(item.amount, item.currency)}</span>,
    },
    {
      header: t('purchase_col_payment_status'),
      mobile: 'secondary',
      render: paymentStatus,
    },
    {
      header: t('purchase_col_status'),
      mobile: 'keep',
      render: (item) => (
        <StatusBadge status={item.status} label={t(`purchase_status_${item.status}` as any)} />
      ),
    },
    {
      header: '',
      width: 48,
      mobile: 'actions',
      render: (item) => {
        const billingPath = billingEventPath(locale, item);
        return (
          <ContextMenu
            ariaLabel={t('purchase_actions_for', { product: item.product_name })}
            items={[
              { label: t('action_details'), onClick: () => setDetail(item) },
              {
                label: t('action_view_billing_event'),
                onClick: () => { if (billingPath) router.push(billingPath); },
                disabled: !hasBillingEvent(item),
                title: hasBillingEvent(item) ? undefined : t('billing_event_unavailable'),
              },
            ]}
          />
        );
      },
    },
  ];

  return (
    <div>
      <CardSectionHeader
        title={t('section_additional_services')}
        actions={(
          <>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={open ? t('products_card_collapse') : t('products_card_expand')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '2px 6px' }}
            >
              {open ? '▾' : '▸'}
            </button>
          </>
        )}
      />
      {/* #1532: the action sits below the heading, left-aligned, as
          `+ Add Membership Plan` does; the empty state stays under it. */}
      <div style={{ marginBottom: 8 }}>
        <button
          type="button"
          disabled={!canWrite || adding}
          title={canWrite ? undefined : t('products_add_read_only')}
          onClick={() => { setOpen(true); setAdding(true); }}
          style={{ ...primaryBtnSmall(), opacity: !canWrite || adding ? 0.5 : 1, cursor: !canWrite || adding ? 'not-allowed' : 'pointer' }}
        >
          {t('products_add')}
        </button>
      </div>
      {open && adding && (
        <AddProductPurchase
          memberId={memberId}
          isAdmin={isAdmin}
          canPay={canPay}
          onClose={() => setAdding(false)}
          onChanged={onChanged}
          onProposal={onProposal}
        />
      )}
      {open && (
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(item) => item.id}
          loadingText=""
          emptyText={t('purchased_products_none')}
          expandedRowKeys={expandedIds}
          onToggleExpand={toggleExpand}
          renderExpanded={(item) => <PurchaseFacts item={item} gymFmt={gymFmt} promotionLabel={promotionLabel} />}
        />
      )}

      <CrudModal
        open={detail !== null}
        title={detail?.product_name ?? ''}
        hideSave
        cancelLabel={t('close')}
        saveLabel=""
        onCancel={() => setDetail(null)}
        onSave={() => setDetail(null)}
      >
        {detail && <PurchaseFacts item={detail} gymFmt={gymFmt} promotionLabel={promotionLabel} />}
      </CrudModal>
    </div>
  );
}

/** The purchase record, read-only: the expanded row and the Details modal. */
function PurchaseFacts({
  item, gymFmt, promotionLabel,
}: {
  item: PurchasedProduct;
  gymFmt: GymFormatSettings;
  promotionLabel: (p: PurchasedProductPromotion) => string;
}) {
  const t = useTranslations('members');
  const dash = '—';
  const payKey = paymentStatusKey(item.payment_status);
  return (
    <div style={{ padding: '8px 0' }}>
      <CardDetailRow label={t('purchase_col_product')} value={item.product_name} />
      <CardDetailRow label={t('purchase_col_date')} value={date(purchaseDate(item), gymFmt)} />
      <CardDetailRow label={t('purchase_col_price_incl_vat')} value={money(item.regular_amount, item.currency)} />
      <CardDetailRow label={t('purchase_col_applied_tax')} value={formatAppliedTax(item.tax_rate_percent) ?? dash} />
      <CardDetailRow
        label={t('purchase_col_applied_promotion')}
        value={item.promotion ? promotionLabel(item.promotion) : dash}
      />
      <CardDetailRow label={t('purchase_col_final_price')} value={money(item.amount, item.currency)} />
      <CardDetailRow
        label={t('purchase_col_payment_status')}
        value={payKey ? t(`purchase_payment_status_${payKey}` as any) : dash}
      />
      <CardDetailRow label={t('purchase_col_status')} value={t(`purchase_status_${item.status}` as any)} />
      <CardDetailRow label={t('purchase_created_by')} value={item.created_by ?? dash} />
    </div>
  );
}

/**
 * The page-wide `123.45€` convention `benefitTreatmentLabel()` already uses, so
 * the amounts beside a treatment are written the same way it is. The currency
 * code is shown only where it is not the euro these screens assume.
 */
function money(amount: number | null | undefined, currency: string): string {
  if (amount == null || !Number.isFinite(Number(amount))) return '—';
  const value = Number(amount).toFixed(2);
  return currency === 'EUR' ? `${value}€` : `${value} ${currency}`;
}

function date(value: string | null, settings: GymFormatSettings): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : formatGymDate(parsed, settings);
}
