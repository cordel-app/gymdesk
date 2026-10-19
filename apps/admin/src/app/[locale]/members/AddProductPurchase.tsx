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

export function AddProductPurchase({
  memberId, isAdmin, recurringOnly = false, embedded = false, onClose, onChanged,
}: {
  memberId: number;
  isAdmin: boolean;
  /** Without Payments write access a recurring Product cannot be committed, so it is not offered. */
  canPay: boolean;
  /** The recurring section offers only recurring Products (they go to its Draft). */
  recurringOnly?: boolean;
  /** #1807: rendered inside the products table's draft row, which supplies the card and the Draft badge. */
  embedded?: boolean;
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
  const [frequencyPrompt, setFrequencyPrompt] = useState<{ existing: string[]; incoming: string } | null>(null);

  const product = useMemo(() => catalogue?.find((p) => p.id === productId) ?? null, [catalogue, productId]);
  const discountValue = parseDiscountInput(discount);

  function describe(err: any): string {
    const code = purchaseErrorKey(err?.body?.error ?? err?.message);
    return code ? t(`add_product_error_${code}` as any) : t('add_product_error');
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ items: PurchasableProductOption[] }>(`${base}/catalogue`)
      .then((r) => { if (!cancelled) setCatalogue(r.items.filter((p) => !recurringOnly || p.recurring)); })
      .catch((err) => { if (!cancelled) { setCatalogue([]); setError(describe(err)); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  // The server's quote, re-asked on every change while nothing is created yet.
  useEffect(() => {
    setQuote(null);
    if (outcome || productId == null || Number.isNaN(discountValue)) return;
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

  function togglePromotion(id: number) {
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

  const canCreate = !busy && !outcome && productId != null && quote != null && !Number.isNaN(discountValue);

  return (
    <div style={embedded ? { padding: '12px 16px' } : { ...innerCardStyle, marginBottom: 12 }} data-add-product-form>
      {/* #1657 — a recurring Product being configured is a Draft line until the one global Save & Pay. */}
      {!embedded && (product != null || recurringOnly) && (
        <div style={{ marginBottom: 8 }} data-add-product-draft-badge>
          <StatusBadge status="draft" label={t('add_product_draft_badge')} />
        </div>
      )}
      <div style={rowStyle} data-add-product-row>
        <div style={{ flex: '2 1 280px', minWidth: 0 }}>
          <label style={formFieldLabelStyle} htmlFor="add-product-select">{t('add_product_select')}</label>
          <select
            id="add-product-select"
            style={formControlStyle}
            value={productId ?? ''}
            disabled={!!outcome || catalogue == null}
            onChange={(e) => pickProduct(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">{t('add_product_select_placeholder')}</option>
            {(catalogue ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.price_incl_tax != null ? money(p.price_incl_tax, p.currency) : '—'} · {p.recurring ? t('add_product_recurring') : t('add_product_one_time')}
              </option>
            ))}
          </select>
        </div>
        {isAdmin && (
          <div style={{ flex: '0 0 110px' }}>
            <label style={formFieldLabelStyle} htmlFor="add-product-discount">{t('add_product_direct_discount')}</label>
            <input
              id="add-product-discount"
              style={{ ...formControlStyle, width: '100%' }}
              inputMode="decimal"
              value={discount}
              disabled={!product || !!outcome}
              onChange={(e) => setDiscount(e.target.value)}
              title={t('add_product_direct_discount_help')}
            />
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
          <div style={{ ...valueCellStyle, fontWeight: 700 }}>{quote ? money(quote.final_price, quote.currency) : '—'}</div>
        </div>
      </div>
      {catalogue != null && catalogue.length === 0 && <p style={cardHintStyle}>{t('add_product_none_available')}</p>}

      {product && !outcome && (
        <>
          <div style={{ ...formFieldLabelStyle, marginTop: 12 }}>{t('add_product_promotions')}</div>
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
            selectedIds={promotionIds}
            onToggle={togglePromotion}
            disabled={busy}
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

      {quote && (quote.promotions.length > 0 || quote.direct_discount_percent != null) && (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          {quote.promotions.map((p) => (
            <div key={p.promotion_id}>{t('quote_promotion', { name: p.promotion_name })}: −{money(p.regular_amount - p.final_amount, quote.currency)}</div>
          ))}
          {quote.direct_discount_percent != null && (
            <div>{t('quote_direct_discount', { percent: quote.direct_discount_percent })}: −{money(quote.direct_discount_amount ?? 0, quote.currency)}</div>
          )}
        </div>
      )}
      {quote && (
        <p style={cardHintStyle}>
          {quote.recurring ? t('add_product_simulation_recurring_hint') : t('add_product_simulation_one_time', { amount: money(quote.final_price, quote.currency) })}
        </p>
      )}

      {outcome?.kind === 'one_time_draft' && (
        <p style={{ fontSize: 14 }}>{t('add_product_purchase_draft_saved')}</p>
      )}

      {outcome?.kind === 'draft_updated' && (
        <p style={{ fontSize: 14 }}>{t('add_product_draft_updated')}</p>
      )}

      {error && <p role="alert" style={formErrorStyle}>{error}</p>}

      <ConfirmDialog
        open={frequencyPrompt != null}
        message={t('frequency_differs_message', {
          existing: (frequencyPrompt?.existing ?? []).map((f) => billingFrequencyLabel(f, tFreq) ?? f).join(', '),
          incoming: frequencyPrompt ? (billingFrequencyLabel(frequencyPrompt.incoming, tFreq) ?? frequencyPrompt.incoming) : '',
        })}
        confirmLabel={t('frequency_differs_continue')}
        cancelLabel={t('add_product_cancel')}
        onConfirm={() => create(true)}
        onCancel={() => setFrequencyPrompt(null)}
        busy={busy}
      />

      <div style={{ ...inlineActionsRowStyle, marginTop: 12 }}>
        {!outcome && (
          <button type="button" style={{ ...primaryBtnSmall(), opacity: canCreate ? 1 : 0.5 }} disabled={!canCreate} onClick={() => create()}>
            {t('add_product_save_draft')}
          </button>
        )}
        {(
          <button type="button" style={secondaryBtnSmall} disabled={busy} onClick={onClose}>
            {outcome ? t('close') : t('add_product_cancel')}
          </button>
        )}
      </div>
    </div>
  );
}
