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
import { billingFrequencyLabel } from '@/lib/billingFrequency';
import { PromotionPicker } from '@/components/PromotionPicker';
import { promotionBenefitDescription } from '@/lib/promotionSelection';
import {
  parseDiscountInput, purchaseErrorKey,
  type PurchasableProductOption, type PurchaseQuote,
} from './purchasedProductsView';

const money = (n: number, currency = 'EUR') => (currency === 'EUR' ? `${n.toFixed(2)}€` : `${n.toFixed(2)} ${currency}`);

// #1656 — one compact row on wide screens; the flex-wrap makes it a clean stack on narrow ones.
const rowStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' };
const valueCellStyle: React.CSSProperties = { padding: '8px 0', fontSize: 14, whiteSpace: 'nowrap' };

type Outcome =
  | { kind: 'one_time_draft' }
  | { kind: 'draft_updated' };

export function useAddProductForm({
  memberId, isAdmin, recurringOnly = false, embedded = false, enabled = true, onClose, onChanged,
}: {
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
  const [productId, setProductId] = useState<number | null>(null);
  const [promotionIds, setPromotionIds] = useState<number[]>([]);
  const [discount, setDiscount] = useState('');
  const [quote, setQuote] = useState<PurchaseQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // #1865: the Draft already bills on other frequencies; Continue re-sends with the confirmation.
  // #2374: the Promotion toggled last, and the promotion selection whose required Products were confirmed.
  const [lastToggled, setLastToggled] = useState<number | null>(null);
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [frequencyPrompt, setFrequencyPrompt] = useState<{ existing: string[]; incoming: string } | null>(null);

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
      return;
    }
    let cancelled = false;
    apiFetch<{ items: PurchasableProductOption[] }>(`${base}/catalogue`)
      .then((r) => { if (!cancelled) setCatalogue(r.items.filter((p) => !recurringOnly || p.recurring)); })
      .catch((err) => { if (!cancelled) { setCatalogue([]); setError(describe(err)); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId, enabled]);

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

  async function create(confirmBillingFrequency = false) {
    if (productId == null || !product) return;
    setFrequencyPrompt(null);
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<any>(base, {
        method: 'POST',
        body: JSON.stringify({
          product_id: productId, promotion_ids: promotionIds, direct_discount_percent: discountValue,
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
        setFrequencyPrompt({ existing: err.body.existing, incoming: String(err.body.incoming) });
      } else {
        setError(describe(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const canCreate = !busy && !outcome && !requiredPending && productId != null && quote != null && !Number.isNaN(discountValue);
  return {
    t, tFreq, isAdmin, embedded, recurringOnly, onClose,
    catalogue, productId, product, promotionIds, discount, setDiscount, quote, error, busy, outcome,
    requiredProducts, requiredPending, selectionKey, setConfirmedKey, cancelRequired, togglePromotion,
    frequencyPrompt, setFrequencyPrompt, pickProduct, create, canCreate,
  };
}

type AddProductForm = ReturnType<typeof useAddProductForm>;

/** The form's fields as the cells of the Products table's draft row (#2372 follow-up). */
export function addProductDraftCells(f: AddProductForm, today: React.ReactNode): Record<string, React.ReactNode> {
  const { t, quote, product } = f;
  return {
    product: (
      <select
        id="add-product-select"
        aria-label={t('add_product_select')}
        style={{ ...formControlStyle, maxWidth: '100%' }}
        value={f.productId ?? ''}
        disabled={!!f.outcome || f.catalogue == null}
        onChange={(e) => f.pickProduct(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">{t('add_product_select_placeholder')}</option>
        {(f.catalogue ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.price_incl_tax != null ? money(p.price_incl_tax, p.currency) : '—'} · {p.recurring ? t('add_product_recurring') : t('add_product_one_time')}
          </option>
        ))}
      </select>
    ),
    date: today,
    price: product?.price_incl_tax != null ? money(product.price_incl_tax, product.currency) : '—',
    tax: quote && quote.tax_rate_percent != null ? `${quote.tax_rate_percent}%` : '—',
    promotion: quote && quote.promotions.length > 0 ? quote.promotions.map((p) => p.promotion_name).join(', ') : '—',
    discount: f.isAdmin ? (
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
    ) : '—',
    final: <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{quote ? money(quote.final_price, quote.currency) : '—'}</span>,
  };
}

/** Promotions, hints, errors, confirmations and actions: everything that is not a cell. */
export function AddProductDetails({ form: f }: { form: AddProductForm }) {
  const { t, tFreq, quote, product, outcome, error, requiredProducts, requiredPending } = f;
  return (
    <div style={{ padding: '12px 16px' }} data-add-product-form>
      {f.catalogue != null && f.catalogue.length === 0 && <p style={cardHintStyle}>{t('add_product_none_available')}</p>}
      {product && !outcome && (
        <>
          <div style={formFieldLabelStyle}>{t('add_product_promotions')}</div>
          <PromotionPicker
            promotions={product.promotions.map((promo) => {
              const d = promotionBenefitDescription(promo, (n) => money(n, product.currency));
              return {
                id: promo.promotion_id,
                name: promo.promotion_name,
                stackable: promo.stackable,
                description: d ? t(d.key as any, d.values as any) : null,
              };
            })}
            selectedIds={f.promotionIds}
            onToggle={f.togglePromotion}
            disabled={f.busy}
            emptyText={t('add_product_no_promotions')}
          />
          {product.promotions.length === 0 && (product.unavailable_promotions ?? []).length > 0 && (
            <p style={cardHintStyle} data-unavailable-promotions>
              {t('add_product_promotions_new_members_only', {
                names: (product.unavailable_promotions ?? []).map((u) => u.promotion_name).join(', '),
              })}
            </p>
          )}
        </>
      )}
      {quote && (
        <p style={cardHintStyle}>
          {quote.recurring ? t('add_product_simulation_recurring_hint') : t('add_product_simulation_one_time', { amount: money(quote.final_price, quote.currency) })}
        </p>
      )}
      {outcome?.kind === 'one_time_draft' && <p style={{ fontSize: 14 }}>{t('add_product_purchase_draft_saved')}</p>}
      {outcome?.kind === 'draft_updated' && <p style={{ fontSize: 14 }}>{t('add_product_draft_updated')}</p>}
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
        message={t('frequency_differs_message', {
          existing: (f.frequencyPrompt?.existing ?? []).map((x) => billingFrequencyLabel(x, tFreq) ?? x).join(', '),
          incoming: f.frequencyPrompt ? (billingFrequencyLabel(f.frequencyPrompt.incoming, tFreq) ?? f.frequencyPrompt.incoming) : '',
        })}
        confirmLabel={t('frequency_differs_continue')}
        cancelLabel={t('add_product_cancel')}
        onConfirm={() => f.create(true)}
        onCancel={() => f.setFrequencyPrompt(null)}
        busy={f.busy}
      />

      <div style={{ ...inlineActionsRowStyle, marginTop: 12 }}>
        {!outcome && (
          <button type="button" style={{ ...primaryBtnSmall(), opacity: f.canCreate ? 1 : 0.5 }} disabled={!f.canCreate} onClick={() => f.create()}>
            {t('add_product_save_draft')}
          </button>
        )}
        <button type="button" style={secondaryBtnSmall} disabled={f.busy} onClick={f.onClose}>
          {outcome ? t('close') : t('add_product_cancel')}
        </button>
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
