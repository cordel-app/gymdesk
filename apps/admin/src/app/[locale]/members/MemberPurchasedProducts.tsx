'use client';

// #1118 §12/§13 — the Admin side of a Product a member bought from the Members
// App: what it was, what it cost, what state it is in, and the **Promotion
// snapshot** it was bought under.
//
// Three of its answers are the rule rather than the implementation.
//
//  - **Everything on screen is the purchase's own frozen copy.** The row comes
//    from `GET /members/:id/products`, which joins neither `products` nor
//    `promotions` — §13 is explicit that the Admin "should not dynamically
//    resolve the current Promotion configuration to determine what was applied
//    historically", which is #635 §16's rule, and migration 228's header says
//    the same about the Product. So a Product renamed or repriced, or a
//    Promotion edited from 50% to 30%, moves nothing here.
//  - **It is read-only in both modes.** A purchase is money that moved: there
//    is no route that edits one and none is offered, so the block carries no
//    control at all rather than one gated on Edit mode (#797's rule read the
//    other way — nothing writes, so nothing is behind the mode).
//  - **The treatment is read in the Promotion's own voice.** The labels come
//    from the `promotions` namespace through `benefitTreatmentLabel()`, the one
//    place a stored `(action, value)` pair becomes words (#896 stage 4) — so
//    this surface adds no second vocabulary and the same application reads the
//    same way here as on the Promotion card (#924 stage 2's rule, one table
//    over).

import React from 'react';
import { useTranslations } from 'next-intl';
import { benefitTreatmentLabel } from '@/components/ProductBenefits';
import {
  cardMutedTextStyle,
  cardSubLabelStyle,
  innerCardStyle,
} from '@/components/formChrome';

/** The Promotion a purchase was made under, as the API reports the snapshot. */
export interface PurchasedProductPromotion {
  id: number;
  promotion_id: number;
  promotion_name: string;
  benefit_action: string;
  benefit_value: number | null;
  duration_cycles: number | null;
  regular_amount: number;
  final_amount: number;
  applied_at: string | null;
}

/** One purchase, exactly as `GET /members/:id/products` answers it. */
export interface PurchasedProduct {
  id: number;
  product_id: number;
  status: string;
  product_name: string;
  product_type: string;
  billing_frequency: string | null;
  units: number | null;
  amount: number;
  currency: string;
  purchased_at: string | null;
  created_at: string | null;
  created_by_name: string | null;
  created_by_type: string | null;
  regular_amount: number;
  promotion: PurchasedProductPromotion | null;
}

export function MemberPurchasedProducts({ items }: { items: PurchasedProduct[] }) {
  const t = useTranslations('members');
  // The Promotion voice (§3's *Promotion* / *No promotion*), which is the one
  // this namespace does not carry — the labels live where they were written.
  const tp = useTranslations('promotions');

  if (items.length === 0) {
    return <p style={dim}>{t('purchased_products_none')}</p>;
  }

  return (
    <div>
      {items.map((item) => (
        <div key={item.id} style={card}>
          <div style={{ fontWeight: 500, fontSize: 14 }}>{item.product_name}</div>
          <Field label={t('purchase_price')}>{money(item.regular_amount, item.currency)}</Field>
          {/* Only where the two differ: a purchase made at the Product's own
              price has one figure, and printing it twice says nothing. */}
          {item.promotion && (
            <Field label={t('purchase_final_price')}>{money(item.amount, item.currency)}</Field>
          )}
          <Field label={t('purchase_status')}>
            {t(`purchase_status_${item.status}` as any)}
          </Field>
          <Field label={t('purchase_date')}>{date(item.purchased_at ?? item.created_at)}</Field>
          {item.promotion && (
            <div style={promotionBlock}>
              <div style={subLabel}>{t('purchase_promotion')}</div>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>{item.promotion.promotion_name}</div>
              <div style={{ ...dim, fontSize: 13 }}>
                {[
                  benefitTreatmentLabel(tp as any, 'promotion', {
                    action: item.promotion.benefit_action,
                    value: item.promotion.benefit_value,
                  } as any),
                  // §6's duration, and only where the Promotion names one: a
                  // one-off Product has no billing cycles to express it in
                  // (#1118's `Q5`), so the API answers `null` and this line
                  // simply does not appear.
                  item.promotion.duration_cycles != null
                    ? t('purchase_promotion_cycles', { count: item.promotion.duration_cycles })
                    : null,
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** The Member card's own `Label: Value` pair — not a second one (#929). */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 4 }}>
      <span style={{ ...cardMutedTextStyle, minWidth: 120, flexShrink: 0 }}>{label}</span>
      <span>{children}</span>
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

function date(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString();
}

// #929: shared with the Member card's other sections (`components/formChrome.ts`).
const dim = cardMutedTextStyle;
const card = innerCardStyle;
const subLabel = cardSubLabelStyle;
const promotionBlock: React.CSSProperties = { marginTop: 8 };
