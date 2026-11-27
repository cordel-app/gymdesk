'use client';

// #3443 — the **Purchases** tab's list: the member's purchases, newest first,
// the next page read as the member scrolls near the end (#3437's sentinel).
// It decides nothing: the request and how a page joins the list are
// `lib/memberPurchaseHistory.ts`', every figure and status the API's, every
// label resolved by the page (`text`) — so it calls no `t()` and spells no
// colour outside `memberChrome.ts` (#983). Each purchase is the app's one
// collapsible card (`MemberCollapsibleCard`); opening one fetches nothing.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { memberTheme, primaryButtonStyle, rowDividerStyle, secondaryButtonStyle, statusPillStyle, statusTone } from '../lib/memberChrome';
import { MemberCollapsibleCard } from './MemberCollapsibleCard';
import {
  appendPurchasePage,
  beneficiaryName,
  hasMorePurchases,
  purchaseEventStatusKey,
  purchaseHistoryPath,
  purchasePaymentStatusKey,
  purchaseStatusKey,
  purchaseStatusToneValue,
  purchaseHeaderAmount,
  type PurchaseHistoryItem,
  type PurchaseHistoryPage,
} from '../lib/memberPurchaseHistory';

export function PurchaseHistoryList({ load, text, formatDate, formatMoney, onOpenPayments, onPay, onCancel, busyId = null, reloadKey = 0 }: {
  /** The page's authenticated GET (`apiFetch`). */
  load: <T>(path: string) => Promise<T>;
  /** Resolves a locale key (with interpolation values) — the page's `t`. */
  text: (key: string, values?: Record<string, string | number>) => string;
  formatDate: (iso: string) => string;
  formatMoney: (amount: number | null) => string | null;
  /** Opens the Payments tab; absent when the member cannot see it. */
  onOpenPayments?: () => void;
  /** #3537 — Pay and Cancel on a purchase awaiting payment, offered where the API says so. */
  onPay?: (p: PurchaseHistoryItem) => void;
  onCancel?: (p: PurchaseHistoryItem) => void;
  /** The purchase an action is running on (its buttons are disabled). */
  busyId?: number | null;
  /** Changing it reads the list again from the first page (after a cancel). */
  reloadKey?: number;
}) {
  const [items, setItems] = useState<PurchaseHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const fetchPage = useCallback(async (offset: number) => {
    setLoading(true);
    setFailed(false);
    try {
      const page = await load<PurchaseHistoryPage>(purchaseHistoryPath(offset));
      setItems((shown) => (offset === 0 ? page.items : appendPurchasePage(shown, page.items)));
      setTotal(page.total);
      setLoaded(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => { void fetchPage(0); }, [fetchPage, reloadKey]);

  const more = loaded && hasMorePurchases(items.length, total);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !more || loading || failed || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        void fetchPage(items.length);
      }
    }, { rootMargin: '200px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, loading, failed, items.length, fetchPage]);

  const label = (key: string | null, fallback = '—') => (key ? text(key) : fallback);

  function renderPurchase(p: PurchaseHistoryItem) {
    // #3495: the header always states an amount — the cart's Initial Payment while In cart, else
    // what was recorded (0 when nothing was) — never a sentence in its place.
    const amount = formatMoney(purchaseHeaderAmount(p)) ?? '—';
    const status = label(purchaseStatusKey(p.status), p.status);
    return (
      <MemberCollapsibleCard
        key={p.id}
        title={p.name ?? formatDate(p.created_at)}
        subtitle={text('purchases.date', { date: formatDate(p.created_at) })}
        center={<span style={statusPillStyle(statusTone(purchaseStatusToneValue(p.status)))}>{status}</span>}
        amount={amount}
        bodyStyle={styles.body}
      >
        <div style={styles.metaRow}>
          <span style={styles.muted}>{text('purchases.total')}</span>
          <strong>{amount}</strong>
        </div>
        {((p.can_pay && onPay) || (p.can_cancel && onCancel)) && (
          <div style={styles.actions} data-purchase-actions>
            {p.can_pay && onPay && (
              <button type="button" style={styles.payButton} disabled={busyId === p.id} onClick={() => onPay(p)}>
                {text('purchases.pay')}
              </button>
            )}
            {p.can_cancel && onCancel && (
              <button type="button" style={styles.button} disabled={busyId === p.id} onClick={() => onCancel(p)}>
                {text('purchases.cancel')}
              </button>
            )}
          </div>
        )}

        <h4 style={styles.heading}>{text('purchases.items_heading')}</h4>
        {p.plans.length === 0 && p.products.length === 0 && <p style={styles.muted}>{text('purchases.no_items')}</p>}
        {p.plans.map((plan, i) => (
          <div key={`plan-${i}`} style={styles.group}>
            <div style={styles.itemRow}>
              <span><span style={styles.kind}>{text('purchases.plan')}</span> {plan.name ?? '—'}</span>
            </div>
            {plan.beneficiaries.length > 0 && (
              <p style={styles.note}>
                {text('purchases.covers', { names: plan.beneficiaries.map((b) => b.name ?? '—').join(', ') })}
              </p>
            )}
            {plan.products.map((line, j) => {
              const forName = beneficiaryName(line.beneficiary, p.owner.id);
              return (
                <div key={j} style={{ ...styles.itemRow, ...styles.nested }}>
                  <span>{line.name ?? '—'}{forName ? ` · ${text('purchases.for', { name: forName })}` : ''}</span>
                  <span style={styles.muted}>{text('purchases.quantity', { quantity: line.quantity })}</span>
                </div>
              );
            })}
          </div>
        ))}
        {p.products.map((line, i) => {
          const forName = beneficiaryName(line.beneficiary, p.owner.id);
          return (
            <div key={`product-${i}`} style={styles.itemRow}>
              <span>
                <span style={styles.kind}>{text(line.kind === 'recurring' ? 'purchases.recurring_product' : 'purchases.product')}</span>
                {' '}{line.name ?? '—'}{forName ? ` · ${text('purchases.for', { name: forName })}` : ''}
              </span>
              <span style={styles.muted}>{text('purchases.quantity', { quantity: line.quantity })}</span>
            </div>
          );
        })}

        <h4 style={styles.heading}>{text('purchases.payments_heading')}</h4>
        {p.billing_events.length === 0 ? (
          <p style={styles.muted}>{text('purchases.no_payment')}</p>
        ) : (
          p.billing_events.map((e) => {
            const eventKey = purchaseEventStatusKey(e.status);
            const paymentKey = purchasePaymentStatusKey(e.payment_status);
            const eventAmount = formatMoney(e.amount != null ? Number(e.amount) : null);
            return (
              <div key={e.id} style={styles.eventRow}>
                <div style={styles.itemRow}>
                  <span>{e.name ?? formatDate(e.created_at)}</span>
                  {eventAmount && <strong>{eventAmount}</strong>}
                </div>
                <div style={styles.pills}>
                  {eventKey && (
                    <span style={statusPillStyle(statusTone(e.status ?? ''))}>
                      {text('purchases.event_status_label', { status: text(eventKey) })}
                    </span>
                  )}
                  {paymentKey && (
                    <span style={statusPillStyle(statusTone(e.payment_status === 'completed' ? 'paid' : e.payment_status ?? ''))}>
                      {text('purchases.payment_status_label', { status: text(paymentKey) })}
                    </span>
                  )}
                </div>
                {(e.payment_method_name || e.paid_at) && (
                  <p style={styles.note}>
                    {[e.payment_method_name, e.paid_at ? text('purchases.paid_on', { date: formatDate(e.paid_at) }) : null]
                      .filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
            );
          })
        )}
        {p.billing_events.length > 0 && onOpenPayments && (
          <button type="button" onClick={onOpenPayments} style={styles.button}>{text('purchases.view_payments')}</button>
        )}
      </MemberCollapsibleCard>
    );
  }

  return (
    <div style={styles.wrap}>
      {loaded && !failed && items.length === 0 && <p style={styles.muted}>{text('purchases.empty')}</p>}
      {items.map(renderPurchase)}
      {loading && <p style={styles.muted} aria-live="polite">{text('purchases.loading')}</p>}
      {failed && (
        <div style={styles.retry}>
          <p role="alert" style={styles.muted}>{text('purchases.load_failed')}</p>
          <button type="button" onClick={() => void fetchPage(items.length)} style={styles.button}>
            {text('purchases.retry')}
          </button>
        </div>
      )}
      <div ref={sentinel} aria-hidden="true" style={styles.sentinel} />
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 10 },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  payButton: { ...primaryButtonStyle, padding: '6px 14px', fontSize: 13 },
  body: { display: 'flex', flexDirection: 'column', gap: 6, padding: '0 16px 14px' },
  metaRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  heading: { margin: '10px 0 2px', fontSize: 13, fontWeight: 700, color: memberTheme.text },
  group: { display: 'flex', flexDirection: 'column', gap: 4 },
  itemRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 14, color: memberTheme.text },
  nested: { paddingLeft: 14 },
  kind: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: memberTheme.textMuted },
  eventRow: { ...rowDividerStyle, display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6 },
  pills: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  note: { margin: 0, fontSize: 12, color: memberTheme.textMuted },
  muted: { margin: 0, fontSize: 13, color: memberTheme.textMuted },
  button: { ...secondaryButtonStyle, alignSelf: 'flex-start', fontSize: 13, padding: '6px 12px' },
  retry: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
  sentinel: { height: 1 },
};
