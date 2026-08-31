'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

interface Benefit {
  benefit_code: string;
  quantity: number | null;
  duration_days: number | null;
  recurrence: string | null;
  valid_from: string | null;
  valid_to: string | null;
}

interface Membership {
  id: number;
  membership_plan_id: number | null;
  base_price: string | null;
  final_price: string | null;
  discount_reason: string | null;
  starts_at: string;
  ends_at: string | null;
  status: 'active' | 'paused' | 'cancelled' | 'expired';
  plan_name: string | null;
  plan_description: string | null;
  billing_interval: number | null;
  billing_unit: 'day' | 'week' | 'month' | 'year' | null;
  benefits: Benefit[];
}

interface Promotion { id: number; name: string; description: string | null }

interface UserPackage {
  id: number;
  package_name: string;
  package_sessions: number;
  sessions_remaining: number;
  expires_at: string;
  status: 'active' | 'consumed' | 'expired' | 'cancelled';
}

interface BillingEvent {
  id: number;
  event_type: 'charge_created' | 'payment_recorded' | 'status_changed' | 'adjustment';
  charge_type_code: string | null;
  previous_status: string | null;
  new_status: string | null;
  amount: string | null;
  notes: string | null;
  created_at: string;
  receipt_number: string | null;
}

interface PaymentRequest {
  id: number;
  amount: string;
  currency: string;
  status: 'pending' | 'completed' | 'failed' | 'expired';
  billing_interval: number | null;
  billing_unit: 'day' | 'week' | 'month' | 'year' | null;
  created_at: string;
}

const day = (d: string | null) => (d ? d.slice(0, 10) : null);

function formatInterval(interval: number, unit: string, t: (k: string) => string): string {
  const unitKey = `billing_unit.${unit}_${interval === 1 ? 'one' : 'other'}`;
  return `${interval} ${t(unitKey)}`;
}

export default function MembershipPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { getToken } = useAuth();
  const { isLinked, loading: appLoading, gymName } = useApp();

  const [membership, setMembership] = useState<Membership | null>(null);
  const [packages, setPackages] = useState<UserPackage[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [events, setEvents] = useState<BillingEvent[]>([]);
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [downloadingReceipt, setDownloadingReceipt] = useState<number | null>(null);

  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    let cancelled = false;
    (async () => {
      try {
        const [mship, ledger, pkgs, promos, prs] = await Promise.all([
          apiFetch<{ membership: Membership | null }>('/me/membership'),
          apiFetch<{ items: BillingEvent[] }>('/me/billing-events?limit=50'),
          apiFetch<UserPackage[]>('/me/class-packages').catch(() => []),
          apiFetch<Promotion[]>('/me/promotions').catch(() => []),
          apiFetch<PaymentRequest[]>('/me/payment-requests').catch(() => []),
        ]);
        if (cancelled) return;
        setMembership(mship.membership);
        setEvents(ledger.items);
        setPackages(pkgs);
        setPromotions(promos);
        setPaymentRequests(prs);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? t('common.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appLoading, isLinked, locale]);

  const pendingRequest = paymentRequests.find(r => r.status === 'pending') ?? null;
  const showStartPayment = !pendingRequest
    && membership?.status === 'active'
    && !!membership?.final_price
    && parseFloat(membership.final_price) > 0;

  // Resolve amount and interval shown in the consent modal
  const consentAmount = pendingRequest
    ? parseFloat(pendingRequest.amount).toFixed(2)
    : membership?.final_price ? parseFloat(membership.final_price).toFixed(2) : '';
  const consentCurrency = pendingRequest?.currency ?? 'EUR';
  const consentInterval = pendingRequest
    ? (pendingRequest.billing_interval ?? membership?.billing_interval ?? null)
    : membership?.billing_interval ?? null;
  const consentUnit = pendingRequest
    ? (pendingRequest.billing_unit ?? membership?.billing_unit ?? null)
    : membership?.billing_unit ?? null;

  async function handleConsentConfirm() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await apiFetch<{ id: number; checkoutUrl: string }>('/me/payment-requests', { method: 'POST' });
      window.location.href = result.checkoutUrl;
    } catch (err: any) {
      if (err.message?.toLowerCase().includes('too many') || err.message?.includes('429')) {
        setSubmitError(t('payment_consent.rate_limited'));
      } else {
        setSubmitError(err.message ?? t('common.error'));
      }
      setSubmitting(false);
    }
  }

  async function downloadReceipt(eventId: number) {
    setDownloadingReceipt(eventId);
    try {
      const token = await getToken();
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`/api/proxy/me/receipts/${eventId}`, { headers });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } finally {
      setDownloadingReceipt(null);
    }
  }

  function openConsent() {
    setConsentChecked(false);
    setSubmitError(null);
    setConsentOpen(true);
  }

  if (loading) {
    return (
      <main style={styles.container}>
        <p style={styles.hint}>{t('membership.loading')}</p>
      </main>
    );
  }

  if (error) {
    return (
      <main style={styles.container}>
        <p style={{ ...styles.hint, color: '#c0392b' }}>{error}</p>
      </main>
    );
  }

  if (!membership) {
    return (
      <main style={styles.container}>
        <div style={styles.emptyCard}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✦</div>
          <h1 style={styles.emptyTitle}>{t('membership.title')}</h1>
          <p style={styles.hint}>{t('membership.empty')}</p>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('membership.title')}</h1>

      <div style={styles.card}>
        <div style={styles.cardHead}>
          <div>
            <p style={styles.planName}>{membership.plan_name ?? '—'}</p>
            {membership.plan_description && (
              <p style={styles.planDesc}>{membership.plan_description}</p>
            )}
          </div>
          <StatusPill status={membership.status} label={t(`membership.status.${membership.status}`)} />
        </div>

        <dl style={styles.dl}>
          <div style={styles.row}>
            <dt style={styles.dt}>{t('membership.price')}</dt>
            <dd style={styles.dd}>
              {membership.final_price ? parseFloat(membership.final_price).toFixed(2) : '—'}
              {membership.discount_reason && (
                <span style={styles.discount}> · {membership.discount_reason}</span>
              )}
              {promotions.length > 0 && (
                <div style={styles.promoLine}>
                  {promotions.map((p) => p.name).join(', ')}
                </div>
              )}
            </dd>
          </div>
          <div style={styles.row}>
            <dt style={styles.dt}>{t('membership.starts')}</dt>
            <dd style={styles.dd}>{day(membership.starts_at) ?? '—'}</dd>
          </div>
          <div style={styles.row}>
            <dt style={styles.dt}>{t('membership.ends')}</dt>
            <dd style={styles.dd}>{day(membership.ends_at) ?? t('membership.ongoing')}</dd>
          </div>
        </dl>
      </div>

      {/* Payment banner */}
      {pendingRequest && (
        <div style={styles.paymentBanner}>
          <div style={styles.bannerContent}>
            <div>
              <p style={styles.bannerHeading}>{t('payment_banner.pending_heading')}</p>
              <p style={styles.bannerAmount}>
                {parseFloat(pendingRequest.amount).toFixed(2)} {pendingRequest.currency}
              </p>
            </div>
            <button style={styles.payNowBtn} onClick={openConsent}>
              {t('payment_banner.pay_now')}
            </button>
          </div>
        </div>
      )}

      {showStartPayment && (
        <div style={styles.startPaymentRow}>
          <button style={styles.startPaymentBtn} onClick={openConsent}>
            {t('payment_banner.start_payment')}
          </button>
        </div>
      )}

      {membership.benefits.length > 0 && (
        <section style={styles.section}>
          <h2 style={styles.h2}>{t('membership.benefits_heading')}</h2>
          <ul style={styles.benefitList}>
            {membership.benefits.map((b, i) => (
              <li key={i} style={styles.benefitItem}>
                <span>{t(`membership.benefit.${b.benefit_code}`)}</span>
                {b.quantity != null && (
                  <span style={styles.benefitMeta}>× {b.quantity}</span>
                )}
                {b.recurrence && (
                  <span style={styles.benefitMeta}>· {t(`membership.recurrence.${b.recurrence}`)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {packages.length > 0 && (
        <section style={styles.section}>
          <h2 style={styles.h2}>{t('membership.packages_heading')}</h2>
          <ul style={styles.eventList}>
            {packages.map((p) => (
              <li key={p.id} style={styles.eventItem}>
                <div style={styles.eventLine}>
                  <span style={styles.eventLabel}>{p.package_name}</span>
                  <span style={styles.eventAmount}>
                    {p.sessions_remaining} / {p.package_sessions}
                  </span>
                </div>
                <div style={styles.eventSub}>
                  {t(`membership.package_status.${p.status}`)}
                  {p.status === 'active' && ` · ${t('membership.expires', { date: p.expires_at.slice(0, 10) })}`}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={styles.section}>
        <h2 style={styles.h2}>{t('membership.history_heading')}</h2>
        {events.length === 0 ? (
          <p style={styles.hint}>{t('membership.history_empty')}</p>
        ) : (
          <ul style={styles.eventList}>
            {events.map((e) => (
              <li key={e.id} style={styles.eventItem}>
                <div style={styles.eventLine}>
                  <span style={styles.eventLabel}>
                    {t(`membership.event.${e.event_type}`)}
                    {e.charge_type_code && ` · ${t(`membership.charge_type.${e.charge_type_code}`)}`}
                  </span>
                  {e.amount && (
                    <span style={styles.eventAmount}>{parseFloat(e.amount).toFixed(2)}</span>
                  )}
                </div>
                <div style={styles.eventSub}>
                  <span>{e.created_at.slice(0, 10)}</span>
                  {e.event_type === 'status_changed' && e.new_status && (
                    <span>
                      {' · '}
                      {e.previous_status ? t(`membership.status.${e.previous_status}`) : '—'}
                      {' → '}
                      {t(`membership.status.${e.new_status}`)}
                    </span>
                  )}
                  {e.notes && <span> · {e.notes}</span>}
                  {e.event_type === 'payment_recorded' && e.receipt_number && (
                    <span>
                      {' · '}
                      <button
                        onClick={() => downloadReceipt(e.id)}
                        disabled={downloadingReceipt === e.id}
                        style={styles.receiptBtn}
                      >
                        {downloadingReceipt === e.id ? '…' : `${t('membership.download_receipt')} (${e.receipt_number})`}
                      </button>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Consent modal */}
      {consentOpen && (
        <div style={styles.overlay} onClick={() => !submitting && setConsentOpen(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>{t('payment_consent.title')}</h2>
            <p style={styles.modalBody}>
              {t('payment_consent.body', {
                gymName: gymName ?? '—',
                amount: consentAmount,
                currency: consentCurrency,
                interval: consentInterval && consentUnit
                  ? formatInterval(consentInterval, consentUnit, (k) => t(k as any))
                  : '—',
              })}
            </p>
            <label style={styles.checkLabel}>
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                disabled={submitting}
                style={{ marginRight: 8 }}
              />
              {t('payment_consent.checkbox')}
            </label>
            {submitError && <p style={styles.submitError}>{submitError}</p>}
            <div style={styles.modalActions}>
              <button
                style={styles.cancelBtn}
                onClick={() => setConsentOpen(false)}
                disabled={submitting}
              >
                {t('payment_consent.cancel')}
              </button>
              <button
                style={{ ...styles.confirmBtn, opacity: (!consentChecked || submitting) ? 0.5 : 1 }}
                onClick={handleConsentConfirm}
                disabled={!consentChecked || submitting}
              >
                {submitting ? t('payment_consent.submitting') : t('payment_consent.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function StatusPill({ status, label }: { status: string; label: string }) {
  const COLORS: Record<string, { bg: string; fg: string }> = {
    active:    { bg: '#e6f6ec', fg: '#1e7e40' },
    paused:    { bg: '#fff4e0', fg: '#b26a00' },
    cancelled: { bg: '#fdeaea', fg: '#c0392b' },
    expired:   { bg: '#f3eafd', fg: '#7d3cbd' },
  };
  const c = COLORS[status] ?? { bg: '#f0f0f0', fg: '#666' };
  return (
    <span style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: '4px 12px', fontSize: 12, fontWeight: 600 }}>
      {label}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, maxWidth: 720, margin: '0 auto' },
  title: { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: '#18181b' },
  card: { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 },
  planName: { margin: 0, fontSize: 20, fontWeight: 700, color: '#18181b' },
  planDesc: { margin: '4px 0 0', fontSize: 13, color: '#71717a' },
  dl: { margin: 0 },
  row: { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid #f0f0f0' },
  dt: { margin: 0, fontSize: 13, color: '#71717a' },
  dd: { margin: 0, fontSize: 15, color: '#18181b', fontWeight: 500 },
  discount: { fontSize: 12, color: '#b26a00', fontWeight: 400 },
  promoLine: { fontSize: 12, color: '#7d3cbd', fontWeight: 400, marginTop: 2 },
  section: { marginTop: 24 },
  h2: { margin: '0 0 12px', fontSize: 16, fontWeight: 600, color: '#18181b' },
  benefitList: { listStyle: 'none', padding: 0, margin: 0 },
  benefitItem: { background: '#fff', borderRadius: 8, padding: '10px 14px', marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' },
  benefitMeta: { fontSize: 13, color: '#71717a' },
  eventList: { listStyle: 'none', padding: 0, margin: 0 },
  eventItem: { background: '#fff', borderRadius: 8, padding: '12px 14px', marginBottom: 6 },
  eventLine: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  eventLabel: { fontSize: 14, fontWeight: 500, color: '#18181b' },
  eventAmount: { fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  eventSub: { fontSize: 12, color: '#71717a', marginTop: 4 },
  receiptBtn: { background: 'none', border: 'none', padding: 0, color: '#1e7e40', textDecoration: 'underline', fontSize: 12, cursor: 'pointer' },
  emptyCard: { background: '#fff', borderRadius: 12, padding: '40px 24px', textAlign: 'center' },
  emptyTitle: { margin: '8px 0 12px', fontSize: 20, fontWeight: 700 },
  hint: { color: '#71717a', fontSize: 14, textAlign: 'center', margin: 0 },
  // Payment banner
  paymentBanner: { marginTop: 16, background: '#fff8e1', border: '1px solid #f9c734', borderRadius: 12, padding: 16 },
  bannerContent: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  bannerHeading: { margin: 0, fontSize: 14, fontWeight: 600, color: '#92600a' },
  bannerAmount: { margin: '4px 0 0', fontSize: 20, fontWeight: 700, color: '#18181b' },
  payNowBtn: { flexShrink: 0, background: '#f9c734', color: '#18181b', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  startPaymentRow: { marginTop: 12, display: 'flex', justifyContent: 'flex-end' },
  startPaymentBtn: { background: 'transparent', color: '#71717a', border: '1px solid #e4e4e7', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: 'pointer' },
  // Consent modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal: { background: '#fff', borderRadius: 16, padding: 24, maxWidth: 480, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' },
  modalTitle: { margin: '0 0 12px', fontSize: 18, fontWeight: 700, color: '#18181b' },
  modalBody: { margin: '0 0 16px', fontSize: 14, color: '#3f3f46', lineHeight: 1.6 },
  checkLabel: { display: 'flex', alignItems: 'flex-start', fontSize: 13, color: '#18181b', cursor: 'pointer', marginBottom: 16 },
  submitError: { margin: '0 0 12px', fontSize: 13, color: '#c0392b' },
  modalActions: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  cancelBtn: { background: 'transparent', border: '1px solid #e4e4e7', borderRadius: 8, padding: '10px 16px', fontSize: 14, cursor: 'pointer', color: '#71717a' },
  confirmBtn: { background: '#18181b', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer', transition: 'opacity 0.15s' },
};
