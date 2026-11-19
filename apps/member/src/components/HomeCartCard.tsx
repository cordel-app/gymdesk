'use client';

// #2973 stage 1 — the cart card on the Home: the same cart My Products shows
// (the member's Draft Product Set plus standalone purchases), read with the
// very same endpoints and decided by `lib/memberCart.ts`. It is read-only; the
// actions (Pay, Cancel, edit) are My Products', one tap away. Colours are
// `memberChrome.ts`'s cart styles, so the card follows the Theme.
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { CartSummary } from '@/components/CartSummary';
import { CartCard, toCartCardItems, cartBeneficiaryLabel } from '@/components/CartCard';
import {
  EMPTY_STANDALONE_CART,
  cartCounts,
  cartItems,
  cartPendingAmount,
  cartPhase,
  type MemberCartView,
  type MemberStandaloneCart,
} from '@/lib/memberCart';
import type { MemberSetReview } from '@/lib/memberProducts';
import { formatPaymentAmount } from '@/lib/memberPayments';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';

interface SetRow { id: number; status: string }

export function HomeCartCard({ viewerId }: { viewerId: number | null }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const gymFormat = useGymFormatSettings();
  const [view, setView] = useState<MemberCartView | null>(null);
  const [standalone, setStandalone] = useState<MemberStandaloneCart>(EMPTY_STANDALONE_CART);
  const [review, setReview] = useState<MemberSetReview | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function read() {
      const cart = await apiFetch<MemberStandaloneCart>('/me/cart/purchases')
        .then((c) => ({ purchases: c?.purchases ?? [], total: c?.total == null ? null : Number(c.total), currency: c?.currency ?? null }))
        .catch(() => EMPTY_STANDALONE_CART);
      let v: MemberCartView | null = null;
      let r: MemberSetReview | null = null;
      try {
        const rows = await apiFetch<SetRow[]>('/me/product-sets');
        const row = rows.find((x) => x.status === 'in_cart') ?? rows.find((x) => x.status === 'pending_payment');
        if (row) {
          v = await apiFetch<MemberCartView>(`/me/product-sets/${row.id}`);
          if (v.status === 'in_cart' && !v.awaiting_staff_setup) {
            r = await apiFetch<MemberSetReview>(`/me/product-sets/${row.id}/review`).catch(() => null);
          }
        }
      } catch { v = null; }
      if (cancelled) return;
      setStandalone(cart); setView(v); setReview(r);
    }
    read();
    // The cart changes elsewhere (My Products): re-read when the tab regains focus.
    const onFocus = () => { read(); };
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    // #2973 stage 2: a cart changed in another tab or by the gym shows up without a reload.
    const timer = window.setInterval(onVisible, 30000);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [apiFetch]);

  const phase = cartPhase(view, viewerId, standalone);
  if (phase == null) return null;

  const items = cartItems(view, viewerId, standalone);
  const { plans, products } = cartCounts(view, viewerId, standalone);
  const currency = review?.currency ?? standalone.currency ?? 'EUR';
  const money = (n: number | null | undefined) => (n == null ? null : formatPaymentAmount(n, currency, gymFormat));
  const totalAmount = phase === 'pending_payment' ? cartPendingAmount(view)
    : phase === 'standalone' ? standalone.total
    : phase === 'draft' ? review?.amount_due ?? null
    : null;
  const total = money(totalAmount);
  const heading = phase === 'awaiting_staff' ? 'membership.cart_staff_heading'
    : phase === 'pending_payment' ? 'membership.cart_pending_heading'
    : 'membership.cart_heading';
  const counts = [
    plans > 0 ? t('membership.cart_plans', { count: plans }) : null,
    products > 0 ? t('membership.cart_products', { count: products }) : null,
  ].filter(Boolean).join(' · ');

  return (
    <CartCard
      dataAttrs={{ 'data-home-cart': true }}
      headingKey={heading}
      counts={counts}
      total={total}
      staffEditing={phase === 'awaiting_staff'}
      hintKeys={phase === 'awaiting_staff' ? ['membership.cart_staff_hint'] : []}
      summary={review && phase === 'draft' ? <CartSummary review={review} /> : undefined}
      items={toCartCardItems(items as any, (a, c) => (a == null ? null : formatPaymentAmount(a, c ?? currency, gymFormat)), cartBeneficiaryLabel(review, t('membership.summary_beneficiary_family')))}
    />
  );
}
