'use client';

// #1521 stage 2 — the inline **Add Product** form of the Products card.
//
// It decides nothing a rule owns. Which Products are offered, which Promotions
// are eligible and compatible, what the final price is and whether a one-time
// Product is already held are the server's answers (`…/product-purchases`), and
// the UI re-asks them on every change; the direct-discount control exists only
// for an Admin, and the server refuses it for anyone else regardless.
//
// A one-time Product becomes a pending purchase with a payment link. A
// recurring one becomes a **Draft ProductSet**: the form then shows that
// Draft's own forecast for the Product and offers Save & Pay (the existing
// workflow, the only thing that activates it) or Discard.

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { cardHintStyle, formControlStyle, formErrorStyle, formFieldLabelStyle, inlineActionsRowStyle, innerCardStyle, secondaryBtnSmall } from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import { ProductSetForecast } from './MemberProductSet';
import type { BillingEventSimulationData } from '@/components/BillingEventSimulation';
import {
  forecastForProduct, parseDiscountInput, purchaseErrorKey,
  type PurchasableProductOption, type PurchaseQuote,
} from './purchasedProductsView';

const money = (n: number, currency = 'EUR') => (currency === 'EUR' ? `${n.toFixed(2)}€` : `${n.toFixed(2)} ${currency}`);

type Outcome =
  | { kind: 'one_time'; checkoutUrl: string }
  | { kind: 'draft'; productSetId: number; productId: number }
  | { kind: 'paying'; checkoutUrl: string | null; activated: boolean };

export function AddProductPurchase({
  memberId, isAdmin, canPay, onClose, onChanged, onProposal,
}: {
  memberId: number;
  isAdmin: boolean;
  /** Without Payments write access a recurring Product cannot be committed, so it is not offered. */
  canPay: boolean;
  onClose: () => void;
  /** A purchase or version changed server-side: re-read the lists. */
  onChanged: () => void;
  /** The Draft ProductSet being proposed (or `null`), for the section below the card. */
  onProposal: (productSetId: number | null) => void;
}) {
  const t = useTranslations('members');
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
  const [forecast, setForecast] = useState<BillingEventSimulationData | null>(null);

  const product = useMemo(() => catalogue?.find((p) => p.id === productId) ?? null, [catalogue, productId]);
  const discountValue = parseDiscountInput(discount);

  function describe(err: any): string {
    const code = purchaseErrorKey(err?.body?.error ?? err?.message);
    return code ? t(`add_product_error_${code}` as any) : t('add_product_error');
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ items: PurchasableProductOption[] }>(`${base}/catalogue`)
      .then((r) => { if (!cancelled) setCatalogue(r.items.filter((p) => canPay || !p.recurring)); })
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

  async function create() {
    if (productId == null || !product) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<any>(base, {
        method: 'POST',
        body: JSON.stringify({ product_id: productId, promotion_ids: promotionIds, direct_discount_percent: discountValue }),
      });
      if (res.kind === 'one_time') {
        setOutcome({ kind: 'one_time', checkoutUrl: res.checkoutUrl });
        onChanged();
      } else {
        setOutcome({ kind: 'draft', productSetId: res.product_set_id, productId });
        onProposal(res.product_set_id);
        const f = await apiFetch<BillingEventSimulationData>(`/product-sets/${res.product_set_id}/billing-event-simulation`);
        setForecast(f);
      }
    } catch (err: any) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveAndPay() {
    if (outcome?.kind !== 'draft') return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<any>(`/product-sets/${outcome.productSetId}/save-and-pay`, { method: 'POST', body: JSON.stringify({}) });
      setOutcome({ kind: 'paying', checkoutUrl: res.checkout_url ?? null, activated: false });
      onProposal(null);
      onChanged();
    } catch (err: any) {
      // Nothing is owed today (the added units bill from the next cycle): the
      // existing free-activation route is the way, still the version's own.
      if ((err?.body?.error ?? err?.message) === 'nothing_to_pay') {
        try {
          await apiFetch(`/product-sets/${outcome.productSetId}/activate`, { method: 'POST', body: JSON.stringify({}) });
          setOutcome({ kind: 'paying', checkoutUrl: null, activated: true });
          onProposal(null);
          onChanged();
        } catch (e2: any) {
          setError(describe(e2));
        }
      } else {
        setError(describe(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (outcome?.kind !== 'draft') return;
    setBusy(true);
    try {
      await apiFetch(`/product-sets/${outcome.productSetId}`, { method: 'DELETE' });
    } catch {
      // A Draft that already expired is gone: nothing left to discard.
    } finally {
      setBusy(false);
      onProposal(null);
      setOutcome(null);
      setForecast(null);
      onChanged();
    }
  }

  const canCreate = !busy && !outcome && productId != null && quote != null && !Number.isNaN(discountValue);

  return (
    <div style={{ ...innerCardStyle, marginBottom: 12 }} data-add-product-form>
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
      {catalogue != null && catalogue.length === 0 && <p style={cardHintStyle}>{t('add_product_none_available')}</p>}

      {product && !outcome && (
        <>
          <div style={{ ...formFieldLabelStyle, marginTop: 12 }}>{t('add_product_promotions')}</div>
          {product.promotions.length === 0 ? (
            <p style={cardHintStyle}>{t('add_product_no_promotions')}</p>
          ) : product.promotions.map((promo) => (
            <label key={promo.promotion_id} style={{ display: 'flex', gap: 8, fontSize: 14, marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={promotionIds.includes(promo.promotion_id)}
                onChange={() => togglePromotion(promo.promotion_id)}
              />
              <span>{promo.promotion_name}{!promo.stackable ? ` · ${t('add_product_not_stackable')}` : ''}</span>
            </label>
          ))}

          {isAdmin && (
            <>
              <label style={{ ...formFieldLabelStyle, marginTop: 12 }} htmlFor="add-product-discount">{t('add_product_direct_discount')}</label>
              <input
                id="add-product-discount"
                style={{ ...formControlStyle, maxWidth: 120 }}
                inputMode="decimal"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
              <p style={cardHintStyle}>{t('add_product_direct_discount_help')}</p>
            </>
          )}
        </>
      )}

      {quote && (
        <div style={{ marginTop: 12, fontSize: 14 }} data-purchase-quote>
          <div>{t('quote_list_price')}: {money(quote.list_price, quote.currency)}</div>
          {quote.promotions.map((s) => (
            <div key={s.promotion_id}>{t('quote_promotion', { name: s.promotion_name })}: −{money(s.regular_amount - s.final_amount, quote.currency)}</div>
          ))}
          {quote.direct_discount_percent != null && (
            <div>
              {t('quote_direct_discount', { percent: quote.direct_discount_percent })}: −{money(quote.direct_discount_amount ?? 0, quote.currency)}
            </div>
          )}
          <div style={{ fontWeight: 600 }}>{t('quote_final_price')}: {money(quote.final_price, quote.currency)}</div>
          <p style={cardHintStyle}>
            {quote.recurring ? t('add_product_simulation_recurring_hint') : t('add_product_simulation_one_time', { amount: money(quote.final_price, quote.currency) })}
          </p>
        </div>
      )}

      {outcome?.kind === 'one_time' && (
        <p style={{ fontSize: 14 }}>
          {t('add_product_purchase_created')}{' '}
          <a href={outcome.checkoutUrl} target="_blank" rel="noreferrer">{t('add_product_payment_link')}</a>
        </p>
      )}

      {outcome?.kind === 'draft' && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 14 }}>{t('add_product_draft_created')}</p>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{t('add_product_simulation_title')}</div>
          <ProductSetForecast forecast={forecastForProduct(forecast, outcome.productId)} loading={forecast == null} error={false} />
        </div>
      )}

      {outcome?.kind === 'paying' && (
        <p style={{ fontSize: 14 }}>
          {outcome.activated ? t('add_product_activated') : t('add_product_purchase_created')}{' '}
          {outcome.checkoutUrl && <a href={outcome.checkoutUrl} target="_blank" rel="noreferrer">{t('add_product_payment_link')}</a>}
        </p>
      )}

      {error && <p role="alert" style={formErrorStyle}>{error}</p>}

      <div style={{ ...inlineActionsRowStyle, marginTop: 12 }}>
        {!outcome && (
          <button type="button" style={{ ...primaryBtnSmall(), opacity: canCreate ? 1 : 0.5 }} disabled={!canCreate} onClick={create}>
            {product?.recurring ? t('add_product_create_draft') : t('add_product_create_purchase')}
          </button>
        )}
        {outcome?.kind === 'draft' && (
          <>
            <button type="button" style={primaryBtnSmall()} disabled={busy} onClick={saveAndPay}>{t('add_product_save_and_pay')}</button>
            <button type="button" style={secondaryBtnSmall} disabled={busy} onClick={discard}>{t('add_product_discard')}</button>
          </>
        )}
        {outcome?.kind !== 'draft' && (
          <button type="button" style={secondaryBtnSmall} disabled={busy} onClick={() => { onProposal(null); onClose(); }}>
            {outcome ? t('close') : t('add_product_cancel')}
          </button>
        )}
      </div>
    </div>
  );
}
