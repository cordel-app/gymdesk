'use client';

// #1521 — the Member card's **Products** card: the Products this Member
// purchased, as an always-open section (#1640) with `+ Add Product` below the list, a list
// of nine columns and a `⋮` per row (Details · View billing event).
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
//  - **A committed purchase is never edited.** It is money that moved: its menu
//    carries no edit action. The one exception is a line of the member's open
//    **Draft** Product Set (#2856), which has charged nothing: its `⋮` offers
//    Edit (the same add form, on that line, through `PUT …/recurring/:lineId`)
//    and Delete (`useDraftLineDelete()`), and neither reaches a committed version. `+ Add Product` opens the inline form (`AddProductPurchase`),
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

import React, { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import { CrudModal } from '@/components/CrudModal';
import { usePurchaseCancel } from './usePurchaseCancel';
import { ItemOriginChip } from '@/components/ItemOriginChip';
import { itemOriginKey } from '@/lib/itemOrigin';
import { CardDetailRow } from '@/components/CardDetailRow';
import { primaryBtnSmall } from '@/components/ui';
import { formatGymDate, formatGymDateOnly, type GymFormatSettings } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { billingFrequencyLabel } from '@/lib/billingFrequency';
import { benefitTreatmentLabel } from '@/components/ProductBenefits';
import { cardMutedTextStyle, formErrorStyle } from '@/components/formChrome';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { usePurchaseDraftActions } from './usePurchaseDraftActions';
import { StatusFilter } from '@/components/StatusFilter';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import { MemberAvatar } from '@/components/MemberAvatar';
import { ProfessionalServiceImageModal } from '@/components/professionalServices/ProfessionalServiceImageModal';
import { PRODUCT_SELECT_THUMBNAIL_SIZE, AddProductActions, AddProductDetails, AddProductFeedback, EditQuantityField, addProductDraftCells, useAddProductForm, type DraftLineEdit } from './AddProductPurchase';
import { PromotionPicker } from '@/components/PromotionPicker';
import { useDraftLineDelete } from './useDraftLineDelete';
import {
  billingEventPath,
  filterPurchasesByStatus,
  orderPurchasesForTable,
  PURCHASE_STATUS_FILTER_DEFAULT,
  PURCHASE_STATUS_FILTER_VALUES,
  formatAppliedTax,
  formatDirectDiscount,
  productTypeLabelKey,
  hasBillingEvent,
  paymentStatusKey,
  purchaseDate,
  type PurchasedProduct,
  type PurchasedProductPromotion,
  displayPurchaseStatus,
  editableDraftLineId,
  yesNoKey,
  sharingTypeKey,
  purchaseEndDisplay,
  purchasePriceCell,
} from './purchasedProductsView';

export type { PurchasedProduct, PurchasedProductPromotion };

export function MemberPurchasedProducts({
  items, memberId, canWrite, canPay, isAdmin, onChanged, committedKey,
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
  /** Bumped when Save & Pay committed a version: the inline Add form closes (#1918). */
  committedKey?: number;
}) {
  const t = useTranslations('members');
  // The Promotion voice (*Promotion* / *No promotion*), which this namespace
  // does not carry — the labels live where they were written.
  const tp = useTranslations('promotions');
  const tFreq = useTranslations('billing_frequency');
  const tProducts = useTranslations('products');
  const locale = useLocale();
  const router = useRouter();
  const gymFmt = useGymFormatSettings();

  const [adding, setAdding] = useState(false);
  useEffect(() => { if (committedKey) setAdding(false); }, [committedKey]);
  // #2372 follow-up: the form's fields are the draft row's own cells.
  const addForm = useAddProductForm({
    memberId, isAdmin, canPay, recurringOnly: false, embedded: true, enabled: adding,
    onClose: () => setAdding(false), onChanged,
  });
  // #1657 stage 2 — a saved one-time draft: Pay promotes it, Cancel hard-deletes it.
  const [discarding, setDiscarding] = useState<PurchasedProduct | null>(null);
  const draft = usePurchaseDraftActions(memberId, onChanged, t('purchase_draft_action_error'), t('purchase_cart_expired_error'));
  const draftBusy = draft.busy;
  const draftError = draft.error;
  const discardDraft = async (item: PurchasedProduct) => { if (await draft.discard(item.id)) setDiscarding(null); };
  const [statusFilter, setStatusFilter] = useState<string>(PURCHASE_STATUS_FILTER_DEFAULT);
  const [detail, setDetail] = useState<PurchasedProduct | null>(null);
  const cancelRequest = usePurchaseCancel(memberId, onChanged);
  // The Cancel action asks first, in the app's own dialog (#1806).
  const [cancelling, setCancelling] = useState<PurchasedProduct | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [imageOf, setImageOf] = useState<PurchasedProduct | null>(null);
  // #2856 — a line of the open Draft Product Set: `⋮ → Edit` opens the add form on it, `⋮ → Delete` removes it.
  const [editing, setEditing] = useState<{ rowId: number; edit: DraftLineEdit } | null>(null);
  const [deleting, setDeleting] = useState<PurchasedProduct | null>(null);
  const lineDelete = useDraftLineDelete(memberId, onChanged, {
    expired: t('add_product_error_draft_expired'), failed: t('draft_line_delete_error'),
  });
  const deleteBusy = lineDelete.busy;
  const deleteError = lineDelete.error;
  useEffect(() => { if (committedKey) setEditing(null); }, [committedKey]);
  // #3020 — `⋮ → Edit` turns the row itself into the add form (same fields, same cells): no second panel below it.
  const editForm = useAddProductForm({
    memberId, isAdmin, canPay, recurringOnly: editing?.edit.kind !== 'one_time', embedded: true, enabled: editing !== null,
    edit: editing?.edit ?? null, onClose: () => setEditing(null), onChanged,
  });

  function startEdit(item: PurchasedProduct, lineId: number, kind: 'recurring' | 'one_time' = 'recurring') {
    setEditing({
      rowId: item.id,
      edit: {
        kind,
        lineId,
        productId: item.product_id,
        quantity: item.quantity ?? 1,
        promotionIds: (item.promotions ?? []).map((p) => p.promotion_id),
        directDiscountPercent: item.direct_discount_percent ?? null,
      },
    });
  }

  async function deleteLine(item: PurchasedProduct) {
    const lineId = editableDraftLineId(item);
    if (lineId == null) return;
    if (await lineDelete.remove(lineId) && editing?.rowId === item.id) setEditing(null);
    setDeleting(null);
  }


  function toggleExpand(item: PurchasedProduct) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
      return next;
    });
  }

  // #1693 — records the cancellation day; the paid period (Valid until) is untouched.
  async function cancelPurchase(item: PurchasedProduct) {
    if (cancelBusy) return;
    setCancelBusy(true);
    setCancelError(null);
    const error = await cancelRequest(item.id, item.source === 'recurring' ? item.product_id : undefined);
    setCancelBusy(false);
    setCancelling(null);
    if (error) setCancelError(error === 'recurring_not_removable' ? t('purchase_cancel_recurring_unavailable') : error);
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

  const baseColumns: Column<PurchasedProduct>[] = [
    {
      key: 'product',
      header: t('purchase_col_product'),
      mobile: 'name',
      title: (item) => item.product_name,
      // #3020 — the applied Promotions share the product line: indented under the name, as when adding a Product.
      render: (item) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {/* #3021 — the Product's thumbnail (initial placeholder with none), as when adding a Product; a click opens the Product modal. */}
            <button
              type="button"
              data-product-thumbnail
              aria-label={item.product_name}
              onClick={(e) => { e.stopPropagation(); setImageOf(item); }}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', flexShrink: 0 }}
            >
              <MemberAvatar name={item.product_name} imageUrl={item.product_image_thumbnail_url ?? item.product_image_url ?? null} size={PRODUCT_SELECT_THUMBNAIL_SIZE} />
            </button>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500, minWidth: 0 }}>{item.product_name}</div>
            </div>
          </div>
          {promotionsArea(item)}
        </div>
      ),
    },
    {
      // #3190 — the Product Type the purchase froze (Fee, Sessions, Merchandise, …).
      key: 'type',
      header: t('purchase_col_type'),
      mobile: 'secondary',
      render: (item) => {
        const key = productTypeLabelKey(item.product_type);
        return <span data-product-type>{key ? tProducts(key as any) : dash}</span>;
      },
    },
    {
      // #3088 — the billing frequency has a column of its own, between Product and Quantity.
      key: 'frequency',
      header: t('purchase_col_frequency'),
      mobile: 'secondary',
      render: (item) => <span data-product-frequency>{billingFrequencyLabel(item.billing_frequency, tFreq) ?? dash}</span>,
    },
    {
      // #3020 — the quantity of a recurring line; a one-off purchase is one unit.
      key: 'quantity',
      header: t('draft_line_quantity'),
      mobile: 'secondary',
      render: (item) => item.quantity ?? 1,
    },
    {
      // #2609 — who the Product is for; the server answers the purchaser when nobody was chosen.
      key: 'assigned_to',
      header: t('purchase_col_assigned_to'),
      mobile: 'secondary',
      render: (item) => item.assigned_member_name ?? dash,
    },
    {
      key: 'date',
      header: t('purchase_col_date'),
      mobile: 'secondary',
      render: (item) => (
        <span style={{ whiteSpace: 'nowrap' }}>{date(purchaseDate(item), gymFmt)}</span>
      ),
    },
    {
      key: 'end_date',
      header: t('purchase_col_end_date'),
      mobile: 'secondary',
      render: (item) => {
        // #1693 / #3189 — decided by purchaseEndDisplay(); Merchandise reads —.
        const end = purchaseEndDisplay(item);
        if (end.kind === 'dash') return dash;
        return <span style={{ whiteSpace: 'nowrap' }}>{end.kind === 'date' ? formatGymDateOnly(end.value, gymFmt) : t('purchase_open_ended')}</span>;
      },
    },
    {
      key: 'price',
      header: t('purchase_col_base_price_incl_vat'),
      mobile: 'secondary',
      render: (item) => <PriceCell item={item} which="base" />,
    },
    {
      key: 'promotion',
      header: t('purchase_col_applied_promotion'),
      mobile: 'secondary',
      render: (item) => {
        const list = item.promotions && item.promotions.length > 0 ? item.promotions : item.promotion ? [item.promotion] : [];
        return list.length > 0 ? list.map((p) => p.promotion_name).join(', ') : dash;
      },
    },
    {
      // #2494 — what that Promotion gave this purchase, from the purchase's own frozen application.
      key: 'promotion_benefit',
      header: t('purchase_col_promotion_benefit'),
      mobile: 'secondary',
      render: (item) => (item.promotion
        ? benefitTreatmentLabel(tp as any, 'promotion', { action: item.promotion.benefit_action, value: item.promotion.benefit_value } as any)
        : dash),
    },
    {
      key: 'discount',
      header: t('purchase_col_direct_discount'),
      mobile: 'secondary',
      render: (item) => formatDirectDiscount(item.direct_discount_percent) ?? dash,
    },
    {
      key: 'final',
      header: t('purchase_col_final_price_incl_vat'),
      mobile: 'secondary',
      render: (item) => <PriceCell item={item} which="final" />,
    },
    {
      key: 'payment_status',
      header: t('purchase_col_payment_status'),
      mobile: 'secondary',
      render: paymentStatus,
    },
    {
      key: 'status',
      header: t('purchase_col_status'),
      mobile: 'keep',
      render: (item) => (
        <>
          <StatusBadge status={displayPurchaseStatus(item)} label={t(`purchase_status_${displayPurchaseStatus(item)}` as any)} />
        </>
      ),
    },
    {
      header: '',
      width: 48,
      mobile: 'actions',
      render: (item) => {
        if (editing?.rowId === item.id) return null; // #3021 — Save / Cancel sit bottom-left of the product (the expanded area)
        const billingPath = billingEventPath(locale, item);
        const isOneTimeDraft = item.status === 'in_cart' && item.source !== 'recurring';
        const draftLineId = editableDraftLineId(item);
        return (
          <ContextMenu
            ariaLabel={t('purchase_actions_for', { product: item.product_name })}
            items={[
              ...(isOneTimeDraft ? [
                {
                  // #3070 — a one-time draft is edited like any other product line; paying it is the cart's
                  // Save & Pay (no Pay in this menu).
                  kind: 'edit' as const, label: t('edit'),
                  onClick: () => startEdit(item, item.id, 'one_time'),
                  disabled: !canWrite || draftBusy,
                  title: canWrite ? undefined : t('products_add_read_only'),
                },
                {
                  label: t('purchase_action_discard_draft'),
                  onClick: () => setDiscarding(item),
                  disabled: !canWrite || draftBusy,
                  danger: true,
                  title: canWrite ? undefined : t('products_add_read_only'),
                },
              ] : []),
              ...(draftLineId != null ? [
                {
                  kind: 'edit' as const, label: t('edit'),
                  onClick: () => startEdit(item, draftLineId),
                  disabled: !canWrite || deleteBusy,
                  title: canWrite ? undefined : t('products_add_read_only'),
                },
                {
                  kind: 'delete' as const, label: t('draft_line_delete'),
                  onClick: () => { lineDelete.clearError(); setDeleting(item); },
                  disabled: !canWrite || deleteBusy,
                  danger: true,
                  title: canWrite ? undefined : t('products_add_read_only'),
                },
              ] : []),
              { kind: 'details' as const, label: t('action_details'), onClick: () => setDetail(item) },
              ...(item.status === 'active' && !item.cancelled_on && !item.pending_termination
                ? [{
                    label: t('purchase_cancel_action'),
                    danger: true,
                    onClick: () => { setCancelError(null); setCancelling(item); },
                    disabled: !canWrite,
                    title: canWrite ? undefined : t('products_add_read_only'),
                  }]
                : []),
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

  // #3020 — the edited row draws the form's cells in the columns' own places; every other row reads as before.
  const editCells: Record<string, React.ReactNode> | null = editing ? (() => {
    const c = addProductDraftCells(editForm, null, { frequencyInCell: false });
    const chosen = (editForm.product?.promotions ?? []).filter((pr) => editForm.promotionIds.includes(pr.promotion_id));
    const benefit = chosen.length === 0 ? dash : chosen.map((pr) => [
      benefitTreatmentLabel(tp as any, 'promotion', { action: pr.action, value: pr.value } as any),
      pr.duration_cycles != null ? t('purchase_promotion_cycles', { count: pr.duration_cycles }) : null,
    ].filter(Boolean).join(' · ')).join(', ');
    return {
      product: c.product,
      frequency: c.frequency,
      quantity: <span data-edit-product-quantity><EditQuantityField form={editForm} label={t('draft_line_quantity')} /></span>,
      price: c.price, tax: c.tax, promotion: c.promotion, promotion_benefit: benefit, discount: c.discount, final: c.final,
    };
  })() : null;
  // #3020 — the Promotions area below the row: checkbox, image and name, in read-only and in edit mode.
  // Edit mode offers the Product's eligible Promotions; read-only lists the ones applied, unchangeable.
  const promotionsArea = (item: PurchasedProduct): React.ReactNode => {
    if (editing?.rowId === item.id) return null; // the edited row's cell already carries the picker
    const applied = item.promotions && item.promotions.length > 0 ? item.promotions : item.promotion ? [item.promotion] : [];
    if (applied.length === 0) return null;
    return (
      <div style={{ padding: '4px 0' }} data-product-promotions>
        <PromotionPicker
          promotions={applied.map((p) => ({
            id: p.promotion_id,
            name: p.promotion_name,
            stackable: true,
            description: [
              benefitTreatmentLabel(tp as any, 'promotion', { action: p.benefit_action, value: p.benefit_value } as any),
              p.duration_cycles != null ? t('purchase_promotion_cycles', { count: p.duration_cycles }) : null,
            ].filter(Boolean).join(' · '),
            imageUrl: p.promotion_image_thumbnail_url ?? p.promotion_image_url ?? null, // #2624 stage 5: the snapshot's frozen image
          }))}
          selectedIds={applied.map((p) => p.promotion_id)}
          onToggle={() => {}}
          disabled
          emptyText=""
          showThumbnails
        />
      </div>
    );
  };
  // The Promotions live in the product cell; the expanded area holds the facts and the edit feedback only.
  const shownExpanded = new Set(expandedIds);
  if (editing) shownExpanded.add(editing.rowId);

  const columns: Column<PurchasedProduct>[] = baseColumns.map((col) => {
    const key = col.key;
    if (!key || !editCells || !(key in editCells)) return col;
    return { ...col, render: (item: PurchasedProduct) => (editing?.rowId === item.id ? editCells[key] : col.render!(item)) } as Column<PurchasedProduct>;
  });

  return (
    <div>
      <ProfessionalServiceImageModal
        target={imageOf ? { name: imageOf.product_name, imageUrl: imageOf.product_image_url, description: imageOf.product_description } : null}
        onClose={() => setImageOf(null)}
        closeLabel={t('close')}
        noImageLabel={t('purchase_exp_image_none')}
        noDescriptionLabel={t('purchase_exp_no_description')}
      />
      {draftError && <p role="alert" style={formErrorStyle}>{draftError}</p>}
      {cancelError && <p role="alert" style={formErrorStyle}>{cancelError}</p>}
      {deleteError && <p role="alert" style={formErrorStyle}>{deleteError}</p>}
      <FilterBar style={{ marginBottom: 8 }}>
        <FilterField label={t('purchase_col_status')} htmlFor="purchase-status-filter">
          <StatusFilter
            id="purchase-status-filter"
            value={statusFilter}
            onChange={setStatusFilter}
            allLabel={t('purchase_filter_all')}
            options={PURCHASE_STATUS_FILTER_VALUES.map((v) => ({ value: v, label: t(`purchase_filter_${v}` as any) }))}
            style={filterControlStyle}
          />
        </FilterField>
      </FilterBar>
      <DataTable
          columns={columns}
          rows={orderPurchasesForTable(filterPurchasesByStatus(items, statusFilter))}
          rowKey={(item) => item.id}
          loadingText=""
          emptyText={t('purchased_products_none')}
          expandedRowKeys={shownExpanded}
          onToggleExpand={toggleExpand}
          clickRowToExpand
          draftRowPosition="bottom"
          alignTop={PRODUCT_SELECT_THUMBNAIL_SIZE}
          draftRow={adding ? (() => {
            const c = addProductDraftCells(addForm, date(new Date().toISOString(), gymFmt), { frequencyInCell: false });
            // #2538 — the benefit of each chosen Promotion, from the Promotion's own action/value/duration.
            const chosen = (addForm.product?.promotions ?? []).filter((pr) => addForm.promotionIds.includes(pr.promotion_id));
            const draftBenefit = chosen.length === 0 ? dash : chosen.map((pr) => [
              benefitTreatmentLabel(tp as any, 'promotion', { action: pr.action, value: pr.value } as any),
              pr.duration_cycles != null ? t('purchase_promotion_cycles', { count: pr.duration_cycles }) : null,
            ].filter(Boolean).join(' · ')).join(', ');
            // #2786 — keyed by each column's `key`, so a column added to the table cannot shift these cells.
            const cells: Record<string, React.ReactNode> = {
              ...c,
              // #3101 — the add row's Quantity starts at 1 and stays editable; #3020 stage 6: for a one-time Product too.
              quantity: <span data-add-product-quantity><EditQuantityField form={addForm} label={t('draft_line_quantity')} /></span>,
              promotion_benefit: draftBenefit,
              status: <StatusBadge key="status" status="in_cart" label={t('add_product_draft_badge')} />,
            };
            return { cells, form: <AddProductDetails form={addForm} /> };
          })() : undefined}
          renderExpanded={(item) => (
            <div>
              {editing?.rowId === item.id ? (<><AddProductFeedback form={editForm} /><div style={{ padding: '4px 16px 8px' }}><AddProductActions form={editForm} /></div></>) : null}
              {expandedIds.has(item.id) && editing?.rowId !== item.id
                ? <ExpandedProductFacts item={item} gymFmt={gymFmt} />
                : null}
            </div>
          )}
      />
      {/* #1640: the action sits below the list, at the bottom of the section. */}
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          disabled={!canWrite || adding}
          title={canWrite ? undefined : t('products_add_read_only')}
          onClick={() => setAdding(true)}
          style={{ ...primaryBtnSmall(), opacity: !canWrite || adding ? 0.5 : 1, cursor: !canWrite || adding ? 'not-allowed' : 'pointer' }}
        >
          {t('products_add')}
        </button>
      </div>

      <ConfirmDialog
        open={discarding !== null}
        message={t('purchase_discard_draft_confirm')}
        confirmLabel={t('purchase_discard_draft_confirm_button')}
        cancelLabel={t('add_product_cancel')}
        busy={draftBusy}
        onConfirm={() => { if (discarding) void discardDraft(discarding); }}
        onCancel={() => setDiscarding(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        message={deleting ? t('draft_line_delete_confirm', { product: deleting.product_name }) : ''}
        confirmLabel={t('draft_line_delete')}
        cancelLabel={t('add_product_cancel')}
        busy={deleteBusy}
        onConfirm={() => { if (deleting) void deleteLine(deleting); }}
        onCancel={() => { if (!deleteBusy) setDeleting(null); }}
      />

      <ConfirmDialog
        open={cancelling !== null}
        message={cancelling ? t(cancelling.source === 'recurring' ? 'purchase_cancel_confirm_recurring' : 'purchase_cancel_confirm', { product: cancelling.product_name }) : ''}
        confirmLabel={t('purchase_cancel_confirm_button')}
        cancelLabel={t('purchase_cancel_keep')}
        busy={cancelBusy}
        onConfirm={() => { if (cancelling) void cancelPurchase(cancelling); }}
        onCancel={() => { if (!cancelBusy) setCancelling(null); }}
      />

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

/**
 * #3021 — the expanded row: the assignment, the Product's configuration and the billing
 * configuration, compactly. Everything else (audit, tax, payment, status) stays in `⋮ → Details`,
 * which renders `PurchaseFacts` unchanged.
 */
function ExpandedProductFacts({ item, gymFmt }: { item: PurchasedProduct; gymFmt: GymFormatSettings }) {
  const t = useTranslations('members');
  const dash = '—';
  const yn = (v: boolean | null | undefined) => {
    const k = yesNoKey(v);
    return k ? t(`purchase_exp_${k}` as any) : dash;
  };
  const sharing = sharingTypeKey(item.product_sharing_type);
  const sectionTitle = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, margin: '0 0 2px', opacity: 0.7 };
  // #3160 — the stored amount is VAT-inclusive; say so only where a rate was stored (no claim of a
  // tax that is not configured, #1121), and give the rate a row of its own.
  const appliedTax = formatAppliedTax(item.tax_rate_percent);
  const price = [money(item.regular_amount, item.currency), appliedTax ? t('purchase_exp_vat_included') : null].filter(Boolean).join(' · ');
  // #3021 — compact: three sections side by side (wrapping on a phone), the way the creation layout is one dense block.
  return (
    <div style={{ padding: '6px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '4px 24px' }} data-product-facts>
      <div>
        <div style={sectionTitle}>{t('purchase_exp_assignment')}</div>
        <CardDetailRow label={t('purchase_exp_start')} value={date(purchaseDate(item), gymFmt)} />
        <CardDetailRow label={t('purchase_exp_end')} value={formatGymDateOnly(item.valid_until, gymFmt)} />
        <CardDetailRow label={t('purchase_exp_quantity')} value={item.quantity ?? 1} />
        <CardDetailRow label={t('purchase_exp_description')} value={item.product_description || dash} />
      </div>
      <div>
        <div style={sectionTitle}>{t('purchase_exp_configuration')}</div>
        <CardDetailRow label={t('purchase_exp_mandatory')} value={yn(item.product_mandatory)} />
        <CardDetailRow label={t('purchase_exp_one_time')} value={yn(item.product_one_time_purchase)} />
        <CardDetailRow label={t('purchase_exp_one_per_member')} value={yn(item.product_one_per_member)} />
        <CardDetailRow label={t('purchase_exp_sharing')} value={sharing ? t(`purchase_exp_sharing_${sharing}` as any) : dash} />
      </div>
      <div>
        <div style={sectionTitle}>{t('purchase_exp_billing')}</div>
        <CardDetailRow label={t('purchase_exp_price')} value={price} />
        <CardDetailRow label={t('purchase_exp_tax')} value={appliedTax ?? dash} />
        {item.product_notes ? <CardDetailRow label={t('purchase_exp_notes')} value={item.product_notes} /> : null}
      </div>
    </div>
  );
}

/** The purchase record, read-only: the Details modal. */
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
      <CardDetailRow label={t('purchase_col_assigned_to')} value={item.assigned_member_name ?? dash} />
      <CardDetailRow label={t('purchase_col_date')} value={date(purchaseDate(item), gymFmt)} />
      <CardDetailRow label={t('purchase_cancelled_on')} value={formatGymDateOnly(item.cancelled_on, gymFmt)} />
      <CardDetailRow label={t('purchase_valid_until')} value={formatGymDateOnly(item.valid_until, gymFmt)} />
      <CardDetailRow
        label={t('purchase_validity')}
        value={item.validity_state ? t(`purchase_validity_${item.validity_state}` as any) : dash}
      />
      <CardDetailRow label={t('purchase_col_base_price_incl_vat')} value={<PriceCell item={item} which="base" />} />
      <CardDetailRow label={t('purchase_col_applied_tax')} value={formatAppliedTax(item.tax_rate_percent) ?? dash} />
      <CardDetailRow
        label={t('purchase_col_applied_promotion')}
        value={item.promotion ? promotionLabel(item.promotion) : dash}
      />
      <CardDetailRow label={t('purchase_col_direct_discount')} value={formatDirectDiscount(item.direct_discount_percent) ?? dash} />
      <CardDetailRow label={t('purchase_col_final_price_incl_vat')} value={<PriceCell item={item} which="final" />} />
      <CardDetailRow
        label={t('purchase_col_payment_status')}
        value={payKey ? t(`purchase_payment_status_${payKey}` as any) : dash}
      />
      <CardDetailRow label={t('purchase_col_status')} value={t(`purchase_status_${item.status}` as any)} />
      <CardDetailRow label={t('purchase_cart')} value={item.purchase_id ?? dash} />
      <CardDetailRow label={t('purchase_created_by')} value={item.created_by ?? dash} />
      <CardDetailRow
        label={t('origin_label')}
        value={<ItemOriginChip label={t(itemOriginKey(item.origin))} />}
      />
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

/**
 * #3359 — a price cell: the line total, and under it (quantity above 1) the `2 × 15.00€`
 * breakdown in the card's muted text, smaller than the total. The figures are
 * `purchasePriceCell()`'s, which takes them from the API.
 */
function PriceCell({ item, which }: { item: PurchasedProduct; which: 'base' | 'final' }) {
  const { total, breakdown } = purchasePriceCell(item, which);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', whiteSpace: 'nowrap' }}>
      <span data-price-total>{money(total, item.currency)}</span>
      {breakdown && (
        <small data-price-breakdown style={{ ...cardMutedTextStyle, fontSize: 11 }}>
          {breakdown.quantity} × {money(breakdown.unit, item.currency)}
        </small>
      )}
    </span>
  );
}

function date(value: string | null, settings: GymFormatSettings): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : formatGymDate(parsed, settings);
}

