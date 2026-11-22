'use client';

// #2973 stage 6 — THE member cart. Home and My Products both mount this one
// component, so the card (status, total, Summary, items, beneficiaries, the
// draft countdown, Pay / Cancel, per-item Cancel, the confirmation dialogs and
// the payment consent) is the same content with the same behaviour wherever it
// is drawn. It reads the cart with the endpoints My Products always used,
// decides through `lib/memberCart.ts` and prices nothing: every figure is the
// server's. The `+ Add Plan` / `+ Add Product` actions are NOT part of the
// cart: the host renders them beside it, and tells the component through
// `onChanged` / `refreshKey` when the cart changed elsewhere.
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useApp } from '@/context/AppContext';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { useDraftCountdown } from '@/lib/useDraftCountdown';
import { formatGymTime } from '@/lib/gymFormat';
import { formatDraftRemaining, isDraftWarning, isExpiredDraft, showsDraftExactTime } from '@/lib/draftCountdown';
import { CartSummary } from '@/components/CartSummary';
import { CartCard, toCartCardItems, cartBeneficiaryLabel } from '@/components/CartCard';
import { MemberDialog } from '@/components/MemberDialog';
import { PreparingCartCard } from '@/components/PreparingCartCard';
import { preparingCartContent } from '@/lib/preparingCart';
import {
  EMPTY_STANDALONE_CART,
  cartCommitAction,
  cartCounts,
  cartErrorKey,
  cartItemQuantityPath,
  cartItemRemovePath,
  CART_PURCHASE_MAX_QUANTITY,
  isValidCartQuantity,
  cartItems,
  cartItemsRemovable,
  cartPendingAmount,
  cartPhase,
  pendingCartCancelErrorKey,
  separateStandaloneCart,
  standaloneCartItems,
  standaloneCommitAction,
  standaloneSecondsLeft,
  type CartItem,
  type MemberCartView,
  type MemberStandaloneCart,
} from '@/lib/memberCart';
import {
  currentSetId,
  draftErrorKey,
  setCommitErrorKey,
  type MemberSetReview,
  type MemberSetRow,
} from '@/lib/memberProducts';
import { formatPaymentAmount } from '@/lib/memberPayments';
import {
  cartMutedStyle,
  cartSecondaryButtonStyle,
  inputStyle,
  memberTheme,
  primaryButtonStyle,
  secondaryButtonStyle,
  sectionCardStyle,
} from '@/lib/memberChrome';
import type { CSSProperties } from 'react';

const cartBtn: CSSProperties = { padding: '11px 22px', fontSize: 15, fontWeight: 700 };
const cartItemBtn: CSSProperties = { padding: '6px 12px', fontSize: 13, fontWeight: 600 };
const busyStyle: CSSProperties = { opacity: 0.6, cursor: 'default' };
const dialogPrimary: CSSProperties = { ...primaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 };
const dialogSecondary: CSSProperties = { ...secondaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 };
const modalBody: CSSProperties = { margin: '0 0 16px', fontSize: 14, color: memberTheme.textSecondary, lineHeight: 1.6 };
const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 };
const modal: CSSProperties = { ...sectionCardStyle, borderRadius: 16, padding: 24, maxWidth: 480, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' };
const modalTitle: CSSProperties = { margin: '0 0 12px', fontSize: 18, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font };
const checkLabel: CSSProperties = { display: 'flex', alignItems: 'flex-start', fontSize: 13, color: memberTheme.text, cursor: 'pointer', marginBottom: 16 };

function formatInterval(interval: number, unit: string, t: (k: string) => string): string {
  return `${interval} ${t(`billing_unit.${unit}_${interval === 1 ? 'one' : 'other'}`)}`;
}

export interface MemberCartProps {
  /** Re-read the cart when this changes (the host's own reload counter). */
  refreshKey?: unknown;
  /** Called after the cart changed through one of its own actions, so the host re-reads what it shows. */
  onChanged?: () => void;
}

export function MemberCart({ refreshKey, onChanged }: MemberCartProps) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { member, gymName } = useApp();
  const gymFmt = useGymFormatSettings();
  const viewerId = member?.id ?? null;

  const [view, setView] = useState<MemberCartView | null>(null);
  const [standalone, setStandalone] = useState<MemberStandaloneCart>(EMPTY_STANDALONE_CART);
  const [standaloneSeconds, setStandaloneSeconds] = useState<number | null>(null);
  const [review, setReview] = useState<MemberSetReview | null>(null);
  const [cartSummary, setCartSummary] = useState<MemberSetReview | null>(null);
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [cartBusy, setCartBusy] = useState<string | null>(null);
  const [cartError, setCartError] = useState<string | null>(null);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [draftErrorKeyState, setDraftErrorKeyState] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmPendingCancel, setConfirmPendingCancel] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [consentCadence, setConsentCadence] = useState<{ interval: number | null; unit: string | null }>({ interval: null, unit: null });

  const load = useCallback(async () => {
    const cart = await apiFetch<MemberStandaloneCart>('/me/cart/purchases')
      .then((c) => ({ purchases: c?.purchases ?? [], total: c?.total == null ? null : Number(c.total), currency: c?.currency ?? null }))
      .catch(() => EMPTY_STANDALONE_CART);
    let v: MemberCartView | null = null;
    let expired = false;
    try {
      const rows = await apiFetch<MemberSetRow[]>('/me/product-sets');
      const id = currentSetId(rows);
      v = id == null ? null : await apiFetch<MemberCartView>(`/me/product-sets/${id}`);
      if (isExpiredDraft(v)) {
        const activeId = currentSetId(rows.filter((r) => r.status !== 'in_cart'));
        v = activeId == null ? null : await apiFetch<MemberCartView>(`/me/product-sets/${activeId}`);
        expired = true;
      }
    } catch { v = null; }
    let r: MemberSetReview | null = null;
    let summary: MemberSetReview | null = null;
    if (v && v.status === 'in_cart' && !v.awaiting_staff_setup) {
      r = await apiFetch<MemberSetReview>(`/me/product-sets/${v.id}/review`).catch(() => null);
    } else if (v && v.status === 'in_cart' && v.awaiting_staff_setup) {
      // #3154: the preparing card shows the set's Initial Payment — the review's own figure;
      // #2973 stage 7: and the full Summary drawn from that same review, read-only.
      summary = await apiFetch<MemberSetReview>(`/me/product-sets/${v.id}/review`).catch(() => null);
    } else if (v && v.status === 'pending_payment') {
      summary = await apiFetch<MemberSetReview>(`/me/product-sets/${v.id}/review`).catch(() => null);
    } else if (!v && cart.purchases.length > 0) {
      summary = await apiFetch<MemberSetReview>('/me/cart/summary').catch(() => null);
    }
    setStandalone(cart);
    setStandaloneSeconds(standaloneSecondsLeft(cart, Date.now()));
    setView(v);
    setReview(r);
    setCartSummary(summary);
    if (expired) setDraftErrorKeyState('membership.draft_error_expired');
  }, [apiFetch]);

  useEffect(() => {
    load();
    // The cart changes elsewhere (another tab, the gym): re-read on focus and every 30 s.
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(onVisible, 30000);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [load, refreshKey]);

  const changed = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  const setSeconds = view?.status === 'in_cart' ? view.expires_in_seconds ?? null : null;
  const secondsLeft = useDraftCountdown(
    setSeconds == null ? standaloneSeconds : standaloneSeconds == null ? setSeconds : Math.min(setSeconds, standaloneSeconds),
    changed,
  );

  const phase = cartPhase(view, viewerId, standalone);
  if (phase == null) return null;

  const currencyOf = (c?: string | null) => c ?? 'EUR';
  const money = (a: number | null | undefined, c?: string | null) => (a == null ? null : formatPaymentAmount(a, currencyOf(c), gymFmt));

  async function commitSet() {
    const action = cartCommitAction(view, review, viewerId, standalone);
    if (action === 'cart_checkout') return checkoutStandalone();
    if (!review || !action || commitBusy) return;
    setCommitBusy(true);
    setCommitError(null);
    try {
      if (action === 'save_and_pay') {
        const out = await apiFetch<{ checkout_url: string }>(`/me/product-sets/${review.product_set_id}/save-and-pay`, { method: 'POST' });
        window.location.href = out.checkout_url;
        return;
      }
      await apiFetch(`/me/product-sets/${review.product_set_id}/activate`, { method: 'POST' });
    } catch (err: any) {
      setCommitError(setCommitErrorKey(err?.message));
    }
    setCommitBusy(false);
    await changed();
  }

  async function checkoutStandalone() {
    if (commitBusy) return;
    setCommitBusy(true);
    setCommitError(null);
    try {
      const out = await apiFetch<{ checkoutUrl: string }>('/me/cart/checkout', { method: 'POST' });
      window.location.href = out.checkoutUrl;
      return;
    } catch (err: any) {
      setCommitError(cartErrorKey(err?.message));
    }
    setCommitBusy(false);
    await changed();
  }

  async function discardCart() {
    setDiscardBusy(true);
    setDraftErrorKeyState(null);
    try {
      if (phase === 'draft' && view && view.status === 'in_cart') {
        await apiFetch(`/me/product-sets/${view.id}`, { method: 'DELETE' });
      }
      for (const p of standalone.purchases) {
        await apiFetch(`/me/cart/purchases/${p.id}`, { method: 'DELETE' });
      }
    } catch (err: any) {
      setDraftErrorKeyState(draftErrorKey(err?.message));
    } finally {
      await changed();
      setDiscardBusy(false);
      setConfirmDiscard(false);
    }
  }

  async function removeItem(item: CartItem) {
    if (cartBusy !== null) return;
    const isStandalone = item.kind === 'purchase' && item.standalone;
    if (!isStandalone && (!view || view.status !== 'in_cart')) return;
    const path = cartItemRemovePath(item, view?.id ?? null);
    if (!path) return;
    setCartBusy(item.key);
    setCartError(null);
    try {
      await apiFetch(path, { method: 'DELETE' });
    } catch (err: any) {
      setCartError(cartErrorKey(err?.message));
    } finally {
      await changed();
      setCartBusy(null);
    }
  }

  async function changeQuantity(item: CartItem, quantity: number) {
    const path = cartItemQuantityPath(item);
    if (!path || cartBusy !== null || !isValidCartQuantity(quantity)) return;
    setCartBusy(item.key);
    setCartError(null);
    try {
      await apiFetch(path, { method: 'PUT', body: JSON.stringify({ quantity }) });
    } catch (err: any) {
      setCartError(cartErrorKey(err?.message));
    } finally {
      await changed();
      setCartBusy(null);
    }
  }

  async function cancelPending() {
    if (!view || view.status !== 'pending_payment' || commitBusy) return;
    setCommitBusy(true);
    setCommitError(null);
    try {
      await apiFetch(`/me/product-sets/${view.id}/cancel`, { method: 'POST' });
    } catch (err: any) {
      setCommitError(pendingCartCancelErrorKey(err?.message));
    } finally {
      setCommitBusy(false);
      setConfirmPendingCancel(false);
      await changed();
    }
  }

  async function openConsent() {
    setConsentChecked(false);
    setConsentError(null);
    setConsentOpen(true);
    // The cadence the member is told is the plan awaiting payment's (#1081); none = a single payment.
    try {
      const m = await apiFetch<{ membership?: any; pending_membership?: any }>('/me/membership');
      const src = m.pending_membership ?? m.membership;
      setConsentCadence({ interval: src?.billing_interval ?? null, unit: src?.billing_unit ?? null });
    } catch { setConsentCadence({ interval: null, unit: null }); }
  }

  async function confirmConsent() {
    setConsentSubmitting(true);
    setConsentError(null);
    try {
      const result = await apiFetch<{ id: number; checkoutUrl: string }>('/me/payment-requests', { method: 'POST' });
      window.location.href = result.checkoutUrl;
    } catch (err: any) {
      setConsentError(err?.message?.toLowerCase().includes('too many') || err?.message?.includes('429')
        ? t('payment_consent.rate_limited') : (err?.message ?? t('common.error')));
      setConsentSubmitting(false);
    }
  }

  const countsText = (plans: number, products: number) => [
    plans > 0 ? t('membership.cart_plans', { count: plans }) : null,
    products > 0 ? t('membership.cart_products', { count: products }) : null,
  ].filter(Boolean).join(' · ');
  const family = t('membership.summary_beneficiary_family');
  const cardItems = (items: CartItem[]) => toCartCardItems(items as any, (a, c) => money(a, c), cartBeneficiaryLabel(review ?? cartSummary, family));
  const errorLine = (key: string | null) => key && (
    <p role="alert" style={{ ...cartMutedStyle, color: memberTheme.statusError, margin: '10px 0 0' }}>{t(key as any)}</p>
  );
  const countdown = (withExact: boolean) => {
    const remaining = formatDraftRemaining(secondsLeft);
    if (remaining == null) return undefined;
    const warn = secondsLeft != null && isDraftWarning(secondsLeft);
    const exact = withExact && secondsLeft != null && showsDraftExactTime(secondsLeft)
      ? formatGymTime(new Date(Date.now() + secondsLeft * 1000), gymFmt) : null;
    return (
      <span data-draft-expiry style={warn ? { ...cartMutedStyle, color: memberTheme.statusWarning, fontWeight: 600 } : cartMutedStyle}>
        {t('membership.draft_expires_in')} {remaining}{exact ? ` (${exact})` : ''}
      </span>
    );
  };
  const busy = commitBusy || discardBusy || cartBusy !== null;

  const itemCancel = (items: CartItem[], allowed: (item: CartItem) => boolean) => (ci: { key: string }) => {
    const item = items.find((x) => x.key === ci.key);
    if (!item || !allowed(item)) return null;
    const quantityPath = cartItemQuantityPath(item);
    return (
      <>
        {quantityPath && item.kind === 'purchase' && (
          <select
            aria-label={t('membership.cart_item_quantity')}
            data-cart-quantity
            value={item.quantity ?? 1}
            disabled={busy}
            style={{ ...inputStyle, width: 'auto', marginRight: 8 }}
            onChange={(e) => changeQuantity(item, Number(e.target.value))}
          >
            {Array.from({ length: CART_PURCHASE_MAX_QUANTITY }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        )}
        <button type="button" style={{ ...cartSecondaryButtonStyle, ...cartItemBtn }} disabled={busy} onClick={() => removeItem(item)}>
          {cartBusy === item.key ? t('membership.cart_removing') : t('membership.cart_item_cancel')}
        </button>
      </>
    );
  };
  const payCancel = (onPay: () => void, onCancel: () => void, payEnabled: boolean) => (
    <>
      <button type="button" style={{ ...primaryButtonStyle, ...cartBtn, ...(busy || !payEnabled ? busyStyle : null) }} disabled={busy || !payEnabled} onClick={onPay}>
        {commitBusy ? t('membership.cart_paying') : t('membership.cart_pay')}
      </button>
      <button type="button" style={{ ...cartSecondaryButtonStyle, ...cartBtn }} disabled={busy} onClick={onCancel}>
        {t('membership.cart_cancel')}
      </button>
    </>
  );

  function standaloneCard(beside: boolean) {
    const items = standaloneCartItems(standalone);
    const action = standaloneCommitAction(standalone);
    const total = standalone.total == null ? '—' : formatPaymentAmount(standalone.total, currencyOf(standalone.currency), gymFmt);
    const error = beside ? cartError : (cartError ?? commitError);
    return (
      <CartCard
        key="standalone"
        dataAttrs={{ 'data-cart-standalone': true }}
        headingKey={beside ? 'membership.cart_standalone_heading' : 'membership.cart_heading'}
        counts={t('membership.cart_products', { count: items.length })}
        total={total}
        hintKeys={beside ? ['membership.cart_standalone_hint'] : []}
        summary={!beside && cartSummary ? <CartSummary review={cartSummary} /> : undefined}
        extra={!beside ? countdown(false) : undefined}
        items={cardItems(items)}
        actions={payCancel(checkoutStandalone, () => setConfirmDiscard(true), !!action)}
        itemAction={itemCancel(items, () => true)}
        footer={errorLine(error)}
      />
    );
  }

  const separate = separateStandaloneCart(view, viewerId, standalone) ? standaloneCard(true) : null;
  const { plans, products } = cartCounts(view, viewerId, standalone);
  let main: JSX.Element;
  if (phase === 'standalone') {
    main = standaloneCard(false);
  } else if (phase === 'awaiting_staff') {
    const due = cartSummary?.amount_due;
    main = (
      <PreparingCartCard
        key="staff"
        content={preparingCartContent(view, gymFmt)}
        initialPayment={due == null ? '—' : formatPaymentAmount(due, cartSummary?.currency ?? 'EUR', gymFmt) ?? '—'}
        summary={cartSummary ? <CartSummary review={cartSummary} /> : undefined}
      />
    );
  } else if (phase === 'pending_payment') {
    const c = cartCounts(view, viewerId);
    const amount = cartPendingAmount(view);
    main = (
      <CartCard
        key="pending"
        dataAttrs={{ 'data-cart-pending': true }}
        headingKey="membership.cart_pending_heading"
        counts={countsText(c.plans, c.products)}
        total={amount == null ? '—' : formatPaymentAmount(amount, 'EUR', gymFmt)}
        hintKeys={['membership.cart_pending_hint']}
        summary={cartSummary ? <CartSummary review={cartSummary} /> : undefined}
        items={cardItems(cartItems(view, viewerId))}
        actions={payCancel(openConsent, () => setConfirmPendingCancel(true), true)}
        footer={errorLine(commitError)}
      />
    );
  } else {
    const items = cartItems(view, viewerId, standalone);
    const action = cartCommitAction(view, review, viewerId, standalone);
    const total = review?.amount_due == null ? '—' : formatPaymentAmount(review.amount_due, review.currency ?? 'EUR', gymFmt);
    const reviewError = review?.error ? setCommitErrorKey(review.error) : null;
    main = (
      <CartCard
        key="draft"
        headingKey="membership.cart_heading"
        counts={countsText(plans, products)}
        total={total}
        summary={review && view?.status === 'in_cart' ? <CartSummary review={review} /> : undefined}
        extra={countdown(true)}
        items={cardItems(items)}
        actions={payCancel(commitSet, () => setConfirmDiscard(true), !!action)}
        itemAction={itemCancel(items, (item) => cartItemsRemovable(view) || (item.kind === 'purchase' && item.standalone))}
        footer={errorLine(cartError ?? commitError ?? draftErrorKeyState ?? reviewError)}
      />
    );
  }

  const pendingAmount = cartPendingAmount(view);
  const consentAmount = pendingAmount != null ? pendingAmount.toFixed(2) : '';
  const recurring = consentCadence.interval != null && consentCadence.unit != null;

  return (
    <div data-cart>
      {main}
      {separate}

      {confirmDiscard && (
        <MemberDialog
          labelledBy="cart-discard-title"
          title={t('membership.cart_discard_title')}
          onClose={discardBusy ? () => {} : () => setConfirmDiscard(false)}
          actions={(
            <>
              <button type="button" style={dialogSecondary} onClick={() => setConfirmDiscard(false)} disabled={discardBusy}>
                {t('membership.cart_discard_keep')}
              </button>
              <button type="button" style={{ ...dialogPrimary, ...(discardBusy ? busyStyle : null) }} onClick={discardCart} disabled={discardBusy}>
                {t('membership.cart_discard_confirm')}
              </button>
            </>
          )}
        >
          <p style={modalBody}>{t('membership.cart_discard_body')}</p>
        </MemberDialog>
      )}

      {confirmPendingCancel && (
        <MemberDialog
          labelledBy="cart-pending-cancel-title"
          title={t('membership.cart_pending_cancel_title')}
          onClose={commitBusy ? () => {} : () => setConfirmPendingCancel(false)}
          actions={(
            <>
              <button type="button" style={dialogSecondary} onClick={() => setConfirmPendingCancel(false)} disabled={commitBusy}>
                {t('membership.cart_pending_cancel_keep')}
              </button>
              <button type="button" style={{ ...dialogPrimary, ...(commitBusy ? busyStyle : null) }} onClick={cancelPending} disabled={commitBusy}>
                {t('membership.cart_pending_cancel_confirm')}
              </button>
            </>
          )}
        >
          <p style={modalBody}>{t('membership.cart_pending_cancel_body')}</p>
        </MemberDialog>
      )}

      {consentOpen && (
        <div style={overlay} onClick={() => !consentSubmitting && setConsentOpen(false)}>
          <div style={modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={modalTitle}>{t(recurring ? 'payment_consent.title' : 'payment_consent.title_once')}</h2>
            <p style={modalBody}>
              {recurring
                ? t('payment_consent.body', {
                  gymName: gymName ?? '—',
                  amount: consentAmount,
                  currency: 'EUR',
                  interval: formatInterval(consentCadence.interval as number, consentCadence.unit as string, (k) => t(k as any)),
                })
                : t('payment_consent.body_once', { gymName: gymName ?? '—', amount: consentAmount, currency: 'EUR' })}
            </p>
            <label style={checkLabel}>
              <input type="checkbox" checked={consentChecked} onChange={(e) => setConsentChecked(e.target.checked)} disabled={consentSubmitting} style={{ marginRight: 8 }} />
              {t(recurring ? 'payment_consent.checkbox' : 'payment_consent.checkbox_once')}
            </label>
            {consentError && <p style={{ margin: '0 0 12px', fontSize: 13, color: memberTheme.statusError }}>{consentError}</p>}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button style={{ ...secondaryButtonStyle, padding: '10px 16px', fontSize: 14 }} onClick={() => setConsentOpen(false)} disabled={consentSubmitting}>
                {t('payment_consent.cancel')}
              </button>
              <button
                style={{ ...primaryButtonStyle, padding: '10px 20px', fontSize: 14, fontWeight: 600, opacity: !consentChecked || consentSubmitting ? 0.5 : 1 }}
                onClick={confirmConsent}
                disabled={!consentChecked || consentSubmitting}
              >
                {consentSubmitting ? t('payment_consent.submitting') : t('payment_consent.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
