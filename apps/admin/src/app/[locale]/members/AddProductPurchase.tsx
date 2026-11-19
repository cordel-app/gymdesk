'use client';

// #1521 stage 2 — the inline **Add Product** form of the Products card.
//
// It decides nothing a rule owns. Which Products are offered, which Promotions
// are eligible and compatible, what the final price is and whether a one-time
// Product is already held are the server's answers (`…/product-purchases`), and
// the UI re-asks them on every change; the direct-discount control exists only
// for an Admin, and the server refuses it for anyone else regardless.
//
// A one-time Product is saved as a **draft** purchase (#1657 stage 2: unpaid,
// paid later from the Products list's row menu). A recurring one is added to the member's **Draft** (#1537: created on first
// use, the same Draft for every later edit — there is no "create draft" step).
// Committing it is the recurring section's one global Save & Pay, never a
// payment of this form.

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { cardHintStyle, formControlStyle, formErrorStyle, formFieldLabelStyle, inlineActionsRowStyle, innerCardStyle, secondaryBtnSmall } from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ProfessionalServiceImageModal } from '@/components/professionalServices/ProfessionalServiceImageModal';
import { billingFrequencyLabel } from '@/lib/billingFrequency';
import { PromotionPicker } from '@/components/PromotionPicker';
import { MemberAvatar } from '@/components/MemberAvatar';
import { promotionBenefitDescription } from '@/lib/promotionSelection';
import {
  hasPromotionBlock, parseDiscountInput, purchaseErrorKey, showsAssigneeSelector,
  type EligibleAssignee, type PurchasableProductOption, type PurchaseQuote,
} from './purchasedProductsView';

const money = (n: number, currency = 'EUR') => (currency === 'EUR' ? `${n.toFixed(2)}€` : `${n.toFixed(2)} ${currency}`);

// #1656 — one compact row on wide screens; the flex-wrap makes it a clean stack on narrow ones.
// #2810: top-aligned, since the Product field grows with the Promotions nested under it.
const rowStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' };
const valueCellStyle: React.CSSProperties = { padding: '8px 0', fontSize: 14, whiteSpace: 'nowrap' };

/** #2854: the selected Product's circular thumbnail, left of the Product selector. */
export const PRODUCT_SELECT_THUMBNAIL_SIZE = 40;

/** #3059: an item named in the billing-frequency confirmation. */
export interface FrequencyPromptItem {
  product_id: number; name: string; billing_frequency: string | null;
  description: string | null; image_url: string | null; image_thumbnail_url: string | null;
}
interface FrequencyPrompt { existing: string[]; incoming: string; existingItems: FrequencyPromptItem[]; incomingItem: FrequencyPromptItem | null }

type Outcome =
  | { kind: 'one_time_draft' }
  | { kind: 'draft_updated' };

/**
 * #2856 — the form opened from a Draft line's `⋮ → Edit`: the Product is fixed,
 * and its quantity, direct discount and Promotions start as the line holds them.
 * Saving sends them to `PUT …/product-purchases/recurring/:lineId`, which
 * changes that line of the same Draft and nothing else.
 */
export interface DraftLineEdit {
  lineId: number;
  productId: number;
  quantity: number;
  promotionIds: number[];
  directDiscountPercent: number | null;
}

export function useAddProductForm({
  memberId, isAdmin, recurringOnly = false, embedded = false, enabled = true, onClose, onChanged, edit = null,
}: {
  /** #2856 — edit this Draft line instead of adding a Product. */
  edit?: DraftLineEdit | null;
  memberId: number;
  isAdmin: boolean;
  /** Without Payments write access a recurring Product cannot be committed, so it is not offered. */
  canPay: boolean;
  /** The recurring section offers only recurring Products (they go to its Draft). */
  recurringOnly?: boolean;
  /** #1807: rendered inside the products table's draft row, which supplies the card and the Draft badge. */
  embedded?: boolean;
  /** The catalogue is read only while the form is open. */
  enabled?: boolean;
  onClose: () => void;
  /** A purchase or version changed server-side: re-read the lists. */
  onChanged: () => void;
}) {
  const t = useTranslations('members');
  const tFreq = useTranslations('billing_frequency');
  const { apiFetch } = useApiClient();
  const base = `/members/${memberId}/product-purchases`;

  const [catalogue, setCatalogue] = useState<PurchasableProductOption[] | null>(null);
  // #2609: the member's family (themself included), and who the Product is for.
  const [assignees, setAssignees] = useState<EligibleAssignee[] | null>(null);
  const [assignedMemberId, setAssignedMemberId] = useState<number>(memberId);
  const [productId, setProductId] = useState<number | null>(null);
  const [promotionIds, setPromotionIds] = useState<number[]>([]);
  const [discount, setDiscount] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [quote, setQuote] = useState<PurchaseQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // #1865: the Draft already bills on other frequencies; Continue re-sends with the confirmation.
  // #2374: the Promotion toggled last, and the promotion selection whose required Products were confirmed.
  const [lastToggled, setLastToggled] = useState<number | null>(null);
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [frequencyPrompt, setFrequencyPrompt] = useState<FrequencyPrompt | null>(null);

  const product = useMemo(() => catalogue?.find((p) => p.id === productId) ?? null, [catalogue, productId]);
  const discountValue = parseDiscountInput(discount);

  function describe(err: any): string {
    const code = purchaseErrorKey(err?.body?.error ?? err?.message);
    return code ? t(`add_product_error_${code}` as any) : t('add_product_error');
  }

  useEffect(() => {
    if (!enabled) {
      // A closed form starts fresh the next time it opens.
      setProductId(null); setPromotionIds([]); setDiscount(''); setQuote(null); setError(null); setOutcome(null);
      setAssignedMemberId(memberId); setQuantity('1');
      return;
    }
    if (edit) {
      setProductId(edit.productId);
      setPromotionIds(edit.promotionIds);
      setDiscount(edit.directDiscountPercent != null ? String(edit.directDiscountPercent) : '');
      setQuantity(String(edit.quantity));
      // The selection the line already holds needs no fresh confirmation of its required Products.
      setConfirmedKey(edit.promotionIds.slice().sort((a, b) => a - b).join(','));
    }
    let cancelled = false;
    apiFetch<{ items: PurchasableProductOption[] }>(`${base}/catalogue`)
      .then((r) => { if (!cancelled) setCatalogue(r.items.filter((p) => !recurringOnly || p.recurring)); })
      .catch((err) => { if (!cancelled) { setCatalogue([]); setError(describe(err)); } });
    apiFetch<{ members: EligibleAssignee[] }>(`${base}/assignees`)
      .then((r) => { if (!cancelled) setAssignees(r.members); })
      .catch(() => { if (!cancelled) setAssignees([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId, enabled, edit?.lineId]);

  // The server's quote, re-asked on every change while nothing is created yet.
  useEffect(() => {
    setQuote(null);
    if (!enabled || outcome || productId == null || Number.isNaN(discountValue)) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      apiFetch<PurchaseQuote>(`${base}/quote`, {
        method: 'POST',
        body: JSON.stringify({ product_id: productId, promotion_ids: promotionIds, direct_discount_percent: discountValue }),
      })
        .then((q) => { if (!cancelled) { setQuote(q); setError(null); } })
        .catch((err) => { if (!cancelled) { setQuote(null); setError(describe(err)); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, promotionIds.join(','), discount, outcome]);

  function pickProduct(id: number | null) {
    setProductId(id);
    setPromotionIds([]);
    setError(null);
  }

  const selectionKey = promotionIds.slice().sort((a, b) => a - b).join(',');
  const requiredProducts = quote?.required_products ?? [];
  const requiredPending = requiredProducts.length > 0 && confirmedKey !== selectionKey;

  function cancelRequired() {
    // Cancel leaves the form as it was: the Promotion just ticked is unticked.
    setPromotionIds((prev) => prev.filter((p) => p !== lastToggled));
  }

  function togglePromotion(id: number) {
    setLastToggled(id);
    setPromotionIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  const showAssignee = showsAssigneeSelector(assignees, product);

  const quantityValue = Number(quantity);
  const quantityValid = Number.isInteger(quantityValue) && quantityValue >= 1 && quantityValue <= 999;

  async function saveEdit() {
    if (!edit) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${base}/recurring/${edit.lineId}`, {
        method: 'PUT',
        body: JSON.stringify({
          quantity: quantityValue,
          promotion_ids: promotionIds,
          // The direct discount is the Admin's alone; anyone else leaves it as stored.
          ...(isAdmin ? { direct_discount_percent: discountValue } : {}),
        }),
      });
      // The edited line is listed with its new figures; the form closes.
      onChanged();
      onClose();
    } catch (err: any) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function create(confirmBillingFrequency = false) {
    if (edit) return saveEdit();
    if (productId == null || !product) return;
    setFrequencyPrompt(null);
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<any>(base, {
        method: 'POST',
        body: JSON.stringify({
          product_id: productId, promotion_ids: promotionIds, direct_discount_percent: discountValue,
          ...(showAssignee ? { assigned_member_id: assignedMemberId } : {}),
          ...(product.recurring ? {} : { draft: true }),
          ...(confirmBillingFrequency ? { confirm_billing_frequency: true } : {}),
          ...(requiredProducts.length > 0 && !requiredPending ? { confirm_required_products: true } : {}),
        }),
      });
      if (res.kind === 'one_time_draft') {
        setOutcome({ kind: 'one_time_draft' });
        onChanged();
        // #1807: the saved row now shows in the list with its persisted status.
        if (embedded) onClose();
      } else {
        // The Draft was created on first use or reused; the section reflects it.
        setOutcome({ kind: 'draft_updated' });
        onChanged();
        // #2372: embedded in the Products table, the saved line is listed there
        // as a regular row, so the form goes away instead of lingering.
        if (embedded) onClose();
      }
    } catch (err: any) {
      if (err?.body?.error === 'billing_frequency_differs' && Array.isArray(err.body.existing)) {
        setFrequencyPrompt({
          existing: err.body.existing, incoming: String(err.body.incoming),
          existingItems: Array.isArray(err.body.existing_items) ? err.body.existing_items : [],
          incomingItem: err.body.incoming_item ?? null,
        });
      } else {
        setError(describe(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const canCreate = !busy && !outcome && !requiredPending && productId != null && quote != null && !Number.isNaN(discountValue)
    && (!edit || quantityValid);
  return {
    edit, quantity, setQuantity, quantityValid,
    t, tFreq, isAdmin, embedded, recurringOnly, onClose,
    catalogue, productId, product, promotionIds, discount, setDiscount, quote, error, busy, outcome,
    requiredProducts, requiredPending, selectionKey, setConfirmedKey, cancelRequired, togglePromotion,
    frequencyPrompt, setFrequencyPrompt, pickProduct, create, canCreate,
    assignees, assignedMemberId, setAssignedMemberId, showAssignee,
  };
}

type AddProductForm = ReturnType<typeof useAddProductForm>;

/**
 * #2810 — the Promotions a Product offers, drawn inside that Product's own cell, under its
 * selector: each Product row carries only its own Promotions, and there is no block of
 * Promotions below the row. Absent when the Product has none to offer (#2783).
 */
export function productPromotionsCell(f: AddProductForm): React.ReactNode {
  const { t, product, outcome } = f;
  if (!product || outcome || !hasPromotionBlock(product)) return null;
  return (
    <div style={{ marginTop: 8 }} data-product-promotions>
      <div style={formFieldLabelStyle}>{t('add_product_promotions')}</div>
      <PromotionPicker
        promotions={product.promotions.map((promo) => {
          const d = promotionBenefitDescription(promo, (n) => money(n, product.currency));
          return {
            id: promo.promotion_id,
            name: promo.promotion_name,
            stackable: promo.stackable,
            description: d ? t(d.key as any, d.values as any) : null,
            // #2854: a Promotion offered here is about this Product, so it shows this Product's thumbnail.
            imageUrl: product.image_url ?? null,
          };
        })}
        selectedIds={f.promotionIds}
        onToggle={f.togglePromotion}
        disabled={f.busy}
        emptyText={t('add_product_no_promotions')}
        showThumbnails
      />
      {product.promotions.length === 0 && (product.unavailable_promotions ?? []).length > 0 && (
        <p style={cardHintStyle} data-unavailable-promotions>
          {t('add_product_promotions_new_members_only', {
            names: (product.unavailable_promotions ?? []).map((u) => u.promotion_name).join(', '),
          })}
        </p>
      )}
    </div>
  );
}

/** The form's fields as the cells of the Products table's draft row (#2372 follow-up). */
export function addProductDraftCells(
  f: AddProductForm,
  today: React.ReactNode,
  opts: { promotionsInCell?: boolean } = {},
): Record<string, React.ReactNode> {
  const { t, quote, product } = f;
  return {
    product: (
      <div style={{ minWidth: 0 }} data-product-cell>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      {/* #2854: the selected Product's thumbnail (initial placeholder with none);
          keyed on the Product so a new selection never shows the previous image. */}
      {product && (
        <span data-product-thumbnail>
          <MemberAvatar
            key={product.id}
            name={product.name}
            imageUrl={product.image_url ?? null}
            size={PRODUCT_SELECT_THUMBNAIL_SIZE}
          />
        </span>
      )}
      <select
        id="add-product-select"
        aria-label={t('add_product_select')}
        style={{ ...formControlStyle, maxWidth: '100%', minWidth: 0, flex: '1 1 auto' }}
        value={f.productId ?? ''}
        disabled={!!f.outcome || f.catalogue == null || f.edit != null}
        onChange={(e) => f.pickProduct(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">{t('add_product_select_placeholder')}</option>
        {(f.catalogue ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.price_incl_tax != null ? money(p.price_incl_tax, p.currency) : '—'} · {p.recurring ? t('add_product_recurring') : t('add_product_one_time')}
          </option>
        ))}
      </select>
      </div>
      {/* #3021 — the billing frequency stays in the product cell while adding or editing, as in the read-only row. */}
      {product && (
        <div data-product-frequency style={{ ...cardHintStyle, fontSize: 12, margin: '2px 0 0' }}>
          {billingFrequencyLabel(product.billing_frequency, f.tFreq) ?? '—'}
        </div>
      )}
      {opts.promotionsInCell === false ? null : productPromotionsCell(f)}
      </div>
    ),
    // #2786 — the Assigned to column's own cell; absent when the selector does not apply.
    assigned_to: f.showAssignee && !f.outcome && !f.edit ? (
      <select
        id="add-product-assignee"
        aria-label={t('add_product_assigned_to')}
        title={t('add_product_assigned_to_help')}
        style={{ ...formControlStyle, maxWidth: '100%' }}
        value={f.assignedMemberId}
        disabled={f.busy}
        onChange={(e) => f.setAssignedMemberId(Number(e.target.value))}
        data-add-product-assignee
      >
        {(f.assignees ?? []).map((m) => (
          <option key={m.member_id} value={m.member_id}>{m.name}</option>
        ))}
      </select>
    ) : '—',
    date: today,
    price: product?.price_incl_tax != null ? money(product.price_incl_tax, product.currency) : '—',
    tax: quote && quote.tax_rate_percent != null ? `${quote.tax_rate_percent}%` : '—',
    promotion: quote && quote.promotions.length > 0 ? quote.promotions.map((p) => p.promotion_name).join(', ') : '—',
    discount: f.isAdmin ? (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        id="add-product-discount"
        aria-label={t('add_product_direct_discount')}
        style={{ ...formControlStyle, width: 72 }}
        inputMode="decimal"
        value={f.discount}
        disabled={!product || !!f.outcome}
        onChange={(e) => f.setDiscount(e.target.value)}
        title={t('add_product_direct_discount_help')}
      />
      <span aria-hidden="true" data-direct-discount-percent>%</span>
      </span>
    ) : '—',
    final: <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{quote ? money(quote.final_price, quote.currency) : '—'}</span>,
  };
}

/** Hints, errors, confirmations and actions: everything that is not a cell (#2810: the Promotions are the Product cell's). */
// #3020 — the quantity input of an edited row, kept here so the read-only card file holds no `<input`.
export function EditQuantityField({ form: f, label }: { form: AddProductForm; label: string }) {
  return (
    <>
      <input
        id="edit-product-quantity"
        aria-label={label}
        type="number"
        min={1}
        max={999}
        style={{ ...formControlStyle, width: 80 }}
        value={f.quantity}
        disabled={f.busy}
        onChange={(e) => f.setQuantity(e.target.value)}
      />
    </>
  );
}

/** Error line and the confirmations a save may raise (no actions, no hints). */
export function AddProductFeedback({ form: f }: { form: AddProductForm }) {
  const { t, tFreq, error, requiredProducts, requiredPending, outcome } = f;
  return (
    <>
      {error && <p role="alert" style={formErrorStyle}>{error}</p>}
      <ConfirmDialog
        open={requiredPending && !outcome}
        message={`${t('required_products_title')}. ${t('required_products_message')}`}
        details={(
          <>
            <ul style={{ margin: 0, paddingLeft: 20 }}>{requiredProducts.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
            <p style={{ margin: '10px 0 0', fontSize: 14 }}>{t('required_products_question')}</p>
          </>
        )}
        confirmLabel={t('required_products_confirm')}
        cancelLabel={t('add_product_cancel')}
        onConfirm={() => f.setConfirmedKey(f.selectionKey)}
        onCancel={f.cancelRequired}
      />
      <ConfirmDialog
        open={f.frequencyPrompt != null}
        title={t('frequency_differs_title')}
        message={t('frequency_differs_message')}
        details={f.frequencyPrompt ? (
          <FrequencyMismatchItems
            prompt={f.frequencyPrompt}
            label={(x) => billingFrequencyLabel(x, tFreq) ?? x}
            currentTitle={t('frequency_differs_current')}
            addingTitle={t('frequency_differs_adding')}
          />
        ) : null}
        question={t('frequency_differs_question')}
        confirmLabel={t('frequency_differs_continue')}
        cancelLabel={t('add_product_cancel')}
        onConfirm={() => f.create(true)}
        onCancel={() => f.setFrequencyPrompt(null)}
        busy={f.busy}
      />
    </>
  );
}

/** Save / Cancel of the form (#3020: also drawn in the edited row's own action cell). */
export function AddProductActions({ form: f }: { form: AddProductForm }) {
  const { t, outcome } = f;
  return (
    <div style={{ ...inlineActionsRowStyle, flexWrap: 'wrap' }} data-product-row-actions>
      {!outcome && (
        <button type="button" style={{ ...primaryBtnSmall(), opacity: f.canCreate ? 1 : 0.5 }} disabled={!f.canCreate} onClick={() => f.create()}>
          {f.edit ? t('draft_line_save') : t('add_product_save_draft')}
        </button>
      )}
      <button type="button" style={secondaryBtnSmall} disabled={f.busy} onClick={f.onClose}>
        {outcome ? t('close') : t('add_product_cancel')}
      </button>
    </div>
  );
}

export function AddProductDetails({ form: f }: { form: AddProductForm }) {
  const { t, quote, outcome } = f;
  return (
    <div style={{ padding: '12px 16px' }} data-add-product-form>
      {f.catalogue != null && f.catalogue.length === 0 && <p style={cardHintStyle}>{t('add_product_none_available')}</p>}
      {quote && (
        <p style={cardHintStyle}>
          {quote.recurring ? t('add_product_simulation_recurring_hint') : t('add_product_simulation_one_time', { amount: money(quote.final_price, quote.currency) })}
        </p>
      )}
      {outcome?.kind === 'one_time_draft' && <p style={{ fontSize: 14 }}>{t('add_product_purchase_draft_saved')}</p>}
      {outcome?.kind === 'draft_updated' && <p style={{ fontSize: 14 }}>{t('add_product_draft_updated')}</p>}
      <AddProductFeedback form={f} />
      <div style={{ marginTop: 12 }}>
        <AddProductActions form={f} />
      </div>
    </div>
  );
}

export function AddProductPurchase(props: Parameters<typeof useAddProductForm>[0]) {
  const form = useAddProductForm(props);
  const { t, quote, product } = form;
  const cells = addProductDraftCells(form, null);
  return (
    <div style={{ ...innerCardStyle, marginBottom: 12 }} data-add-product-form>
      <div style={{ marginBottom: 8 }} data-add-product-draft-badge>
        <StatusBadge status="draft" label={t('add_product_draft_badge')} />
      </div>
      <div style={rowStyle} data-add-product-row>
        <div style={{ flex: '2 1 280px', minWidth: 0 }}>
          <label style={formFieldLabelStyle} htmlFor="add-product-select">{t('add_product_select')}</label>
          {cells.product}
        </div>
        {form.edit && (
          <div style={{ flex: '0 0 96px' }}>
            <label style={formFieldLabelStyle} htmlFor="edit-product-quantity">{t('draft_line_quantity')}</label>
            <input
              id="edit-product-quantity"
              type="number"
              min={1}
              max={999}
              style={{ ...formControlStyle, width: 80 }}
              value={form.quantity}
              disabled={form.busy}
              onChange={(e) => form.setQuantity(e.target.value)}
              data-edit-product-quantity
            />
          </div>
        )}
        {form.showAssignee && !form.outcome && !form.edit && (
          <div style={{ flex: '1 1 180px', minWidth: 0 }}>
            <label style={formFieldLabelStyle} htmlFor="add-product-assignee">{t('add_product_assigned_to')}</label>
            {cells.assigned_to}
          </div>
        )}
        {form.isAdmin && (
          <div style={{ flex: '0 0 110px' }}>
            <label style={formFieldLabelStyle} htmlFor="add-product-discount">{t('add_product_direct_discount')}</label>
            {cells.discount}
          </div>
        )}
        <div style={{ flex: '1 1 130px', minWidth: 0 }} data-purchase-vat>
          <div style={formFieldLabelStyle}>{t('quote_vat')}</div>
          <div style={valueCellStyle}>
            {quote && quote.tax_rate_percent != null && quote.tax_amount != null
              ? `${quote.tax_rate_percent}% · ${money(quote.tax_amount, quote.currency)}`
              : '—'}
          </div>
        </div>
        <div style={{ flex: '0 1 130px', textAlign: 'right' }} data-purchase-quote>
          <div style={formFieldLabelStyle}>{t('quote_final_price')}</div>
          <div style={valueCellStyle}>{cells.final}</div>
        </div>
      </div>
      <AddProductDetails form={form} />
    </div>
  );
}

/**
 * #2856 — the form a Draft line's `⋮ → Edit` opens in that row's expanded area:
 * the add form itself, on that line (Product fixed, quantity, discount and
 * Promotions editable), so editing has no second form or rule of its own.
 */
export function EditDraftLineForm(props: Omit<Parameters<typeof useAddProductForm>[0], 'recurringOnly' | 'edit'> & { edit: DraftLineEdit }) {
  return <AddProductPurchase {...props} recurringOnly />;
}

/**
 * #3059 — the items behind a billing-frequency mismatch: the ones already in the cart or active,
 * then the one being added, each a circular thumbnail (click: the Product modal), name and frequency.
 */
function FrequencyMismatchItems({ prompt, label, currentTitle, addingTitle }: {
  prompt: FrequencyPrompt; label: (f: string) => string; currentTitle: string; addingTitle: string;
}) {
  const t = useTranslations('members');
  const [shown, setShown] = useState<FrequencyPromptItem | null>(null);
  const row = (it: FrequencyPromptItem) => (
    <li key={it.product_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <button type="button" data-frequency-item-thumbnail aria-label={it.name}
        onClick={(e) => { e.stopPropagation(); setShown(it); }}
        style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', flexShrink: 0 }}>
        <MemberAvatar name={it.name} imageUrl={it.image_thumbnail_url ?? it.image_url ?? null} size={32} />
      </button>
      <span style={{ fontSize: 14, minWidth: 0 }}>
        {it.name}{it.billing_frequency ? ` — ${label(it.billing_frequency)}` : ''}
      </span>
    </li>
  );
  const list = (items: FrequencyPromptItem[]) => (
    <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', maxHeight: 180, overflowY: 'auto' }}>{items.map(row)}</ul>
  );
  return (
    <div data-frequency-mismatch>
      <ProfessionalServiceImageModal
        target={shown ? { name: shown.name, imageUrl: shown.image_url, description: shown.description } : null}
        onClose={() => setShown(null)}
        closeLabel={t('close')}
        noImageLabel={t('purchase_exp_image_none')}
        noDescriptionLabel={t('purchase_exp_no_description')}
      />
      <div style={{ fontWeight: 600, fontSize: 14 }}>{currentTitle}</div>
      {list(prompt.existingItems)}
      {prompt.incomingItem && (
        <>
          <div style={{ fontWeight: 600, fontSize: 14, marginTop: 12 }}>{addingTitle}</div>
          {list([prompt.incomingItem])}
        </>
      )}
    </div>
  );
}
