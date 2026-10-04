'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import {
  destructiveButtonStyle,
  memberTheme,
  noticeStyle,
  primaryButtonStyle,
  rowDividerStyle,
  secondaryButtonStyle,
  sectionCardStyle,
  statusPillStyle,
  statusTone,
} from '@/lib/memberChrome';

type BenefitCategory = 'oneoff' | 'session' | 'periodical';

/**
 * #635 stage 10 — one Product the member's Assigned Plan carries, at the
 * quantity, frequency and price it was agreed at. The server resolves it from
 * the assignment's own snapshot, so editing the Membership Plan or repricing
 * the item afterwards never moves what is shown here (§13/§14/§17).
 */
interface Benefit {
  category: BenefitCategory;
  product_id: number;
  name: string;
  quantity: number;
  billing_frequency: string | null;
  unit_price: number;
}

// The order the Plans, Promotions and Assigned Plans pages list the sections in.
const BENEFIT_GROUPS: BenefitCategory[] = ['oneoff', 'session', 'periodical'];

interface UpcomingPayment {
  date: string;
  amount: string;
  status: string;
}

interface Membership {
  id: number;
  membership_plan_id: number | null;
  base_price: string | null;
  membership_fee: number | null;
  discount_reason: string | null;
  starts_at: string;
  ends_at: string | null;
  next_billing_date: string | null;
  status: 'active' | 'paused' | 'cancelled' | 'expired';
  plan_name: string | null;
  plan_description: string | null;
  billing_interval: number | null;
  billing_unit: 'day' | 'week' | 'month' | 'year' | null;
  benefits: Benefit[];
  upcoming_payments: UpcomingPayment[];
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

/**
 * #788: the card the member's recurring charges are taken from. The token that
 * charges it never reaches the app — only the brand, the last four digits and
 * when the card on file was stored.
 */
interface StoredCard {
  provider: string;
  card_brand: string | null;
  card_last4: string | null;
  since: string | null;
}

interface PaymentMethodState {
  payment_method: StoredCard | null;
  can_remove: boolean;
  removal_blocked_reason: string | null;
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
  const { isLinked, loading: appLoading, gymName, isSuperadmin } = useApp();
  const { isImpersonating } = useImpersonation();
  const { flags: featureFlags } = useFeatureFlags();

  const [membership, setMembership] = useState<Membership | null>(null);
  const [packages, setPackages] = useState<UserPackage[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [events, setEvents] = useState<BillingEvent[]>([]);
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  const [card, setCard] = useState<PaymentMethodState | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
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
    if (!(isSuperadmin && !isImpersonating) && !isFeatureEnabled(featureFlags, 'member_web.my_membership')) { router.replace(`/${locale}`); return; }
    let cancelled = false;
    (async () => {
      try {
        const [mship, ledger, pkgs, promos, prs, pm] = await Promise.all([
          apiFetch<{ membership: Membership | null }>('/me/membership'),
          apiFetch<{ items: BillingEvent[] }>('/me/billing-events?limit=50'),
          apiFetch<UserPackage[]>('/me/class-packages').catch(() => []),
          apiFetch<Promotion[]>('/me/promotions').catch(() => []),
          apiFetch<PaymentRequest[]>('/me/payment-requests').catch(() => []),
          apiFetch<PaymentMethodState>('/me/payment-method').catch(() => null),
        ]);
        if (cancelled) return;
        setMembership(mship.membership);
        setEvents(ledger.items);
        setPackages(pkgs);
        setPromotions(promos);
        setPaymentRequests(prs);
        setCard(pm);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? t('common.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appLoading, isLinked, locale, isSuperadmin, isImpersonating, featureFlags]);

  const pendingRequest = paymentRequests.find(r => r.status === 'pending') ?? null;
  const showStartPayment = !pendingRequest
    && membership?.status === 'active'
    && membership?.membership_fee != null
    && membership.membership_fee > 0;

  // Resolve amount and interval shown in the consent modal
  const consentAmount = pendingRequest
    ? parseFloat(pendingRequest.amount).toFixed(2)
    : membership?.membership_fee != null ? membership.membership_fee.toFixed(2) : '';
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

  /**
   * Replacing a card costs nothing: the hosted page runs a zero-amount
   * verification and its own consent checkbox is what authorises the future
   * recurring charges, which is why there is no consent modal on this side.
   */
  async function replaceCard() {
    setCardBusy(true);
    setCardError(null);
    try {
      const result = await apiFetch<{ id: number; checkoutUrl: string }>(
        '/me/payment-method/replace-requests', { method: 'POST' },
      );
      window.location.href = result.checkoutUrl;
    } catch (err: any) {
      if (err.message?.toLowerCase().includes('too many') || err.message?.includes('429')) {
        setCardError(t('payment_method.rate_limited'));
      } else {
        setCardError(err.message ?? t('common.error'));
      }
      setCardBusy(false);
    }
  }

  async function removeCard() {
    if (!window.confirm(t('payment_method.remove_confirm'))) return;
    setCardBusy(true);
    setCardError(null);
    try {
      await apiFetch('/me/payment-method', { method: 'DELETE' });
      const refreshed = await apiFetch<PaymentMethodState>('/me/payment-method').catch(() => null);
      setCard(refreshed);
    } catch (err: any) {
      // The button is hidden when the server says removal is blocked, so a 409
      // here means the membership changed under the member (a plan assigned in
      // another tab, a staff reactivation) — show the reason in their language
      // rather than the API's error code, and re-read the state that changed.
      if (err.message === 'billable_membership') {
        setCardError(t('payment_method.remove_blocked'));
        setCard(await apiFetch<PaymentMethodState>('/me/payment-method').catch(() => null));
      } else {
        setCardError(err.message ?? t('common.error'));
      }
    } finally {
      setCardBusy(false);
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
        <p style={{ ...styles.hint, color: memberTheme.statusError }}>{error}</p>
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
              {membership.membership_fee != null ? membership.membership_fee.toFixed(2) : '—'}
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
            <dt style={styles.dt}>{t('membership.member_since')}</dt>
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

      {/* #788: the stored card, and the two things a member can do with it.
          Replacing is always offered — it used to require paying a whole
          membership fee through the Start payment button — and removing only
          once nothing is scheduled to be charged any more. */}
      <section style={styles.section}>
        <h2 style={styles.h2}>{t('payment_method.heading')}</h2>
        {card?.payment_method ? (
          <>
            <p style={styles.cardLine}>
              {card.payment_method.card_brand ?? t('payment_method.card')}
              {card.payment_method.card_last4 ? ` •••• ${card.payment_method.card_last4}` : ''}
            </p>
            {card.payment_method.since && (
              <p style={styles.hint}>
                {t('payment_method.since', { date: day(card.payment_method.since) ?? '' })}
              </p>
            )}
          </>
        ) : (
          <p style={styles.hint}>{t('payment_method.none')}</p>
        )}
        <div style={styles.cardActions}>
          <button style={styles.startPaymentBtn} onClick={replaceCard} disabled={cardBusy}>
            {card?.payment_method ? t('payment_method.replace') : t('payment_method.add')}
          </button>
          {card?.payment_method && card.can_remove && (
            <button style={styles.removeCardBtn} onClick={removeCard} disabled={cardBusy}>
              {t('payment_method.remove')}
            </button>
          )}
        </div>
        {card?.payment_method && !card.can_remove && (
          <p style={styles.hint}>{t('payment_method.remove_blocked')}</p>
        )}
        {cardError && <p style={{ ...styles.hint, color: memberTheme.statusError }}>{cardError}</p>}
      </section>

      {membership.benefits.length > 0 && (
        <section style={styles.section}>
          <h2 style={styles.h2}>{t('membership.benefits_heading')}</h2>
          {BENEFIT_GROUPS.map((group) => {
            const rows = membership.benefits.filter((b) => b.category === group);
            if (rows.length === 0) return null;
            return (
              <div key={group} style={styles.benefitGroup}>
                <h3 style={styles.h3}>{t(`membership.benefit_group.${group}`)}</h3>
                <ul style={styles.benefitList}>
                  {rows.map((b) => (
                    <li key={`${b.category}-${b.product_id}`} style={styles.benefitItem}>
                      <span>{b.name}</span>
                      <span style={styles.benefitMeta}>× {b.quantity}</span>
                      {/* The frozen price, not the catalogue's: what this
                          membership was agreed at (§17). */}
                      <span style={styles.benefitMeta}>· {b.unit_price.toFixed(2)}</span>
                      {b.billing_frequency && (
                        <span style={styles.benefitMeta}>
                          · {t(`membership.frequency.${b.billing_frequency}`)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
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
        <h2 style={styles.h2}>{t('membership.upcoming_heading')}</h2>
        {membership.upcoming_payments.length === 0 ? (
          <p style={styles.hint}>{t('membership.upcoming_empty')}</p>
        ) : (
          <ul style={styles.eventList}>
            {membership.upcoming_payments.map((p, i) => (
              <li key={i} style={styles.eventItem}>
                <div style={styles.eventLine}>
                  <span style={styles.eventLabel}>{p.date}</span>
                  <span style={styles.eventAmount}>{p.amount}</span>
                </div>
                <div style={styles.eventSub}>
                  <EventStatusPill status={p.status} label={t(`membership.upcoming_status.${p.status}` as any)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

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
                  {/* #787: any event carrying a receipt number offers the
                      download — a recurring charge now gets one too. The
                      number is the gate: the server only ever allocates it
                      for a payment that was received. */}
                  {e.receipt_number && (
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

// #983 — both pills read their tone from `lib/memberChrome.ts`, which is also
// where the dashboard and My Bookings read theirs: the same billing event
// status must not be one colour here and another there.
function EventStatusPill({ status, label }: { status: string; label: string }) {
  return <span style={{ ...statusPillStyle(statusTone(status)), padding: '2px 8px', fontSize: 11 }}>{label}</span>;
}

function StatusPill({ status, label }: { status: string; label: string }) {
  return <span style={{ ...statusPillStyle(statusTone(status)), padding: '4px 12px' }}>{label}</span>;
}

const styles: Record<string, React.CSSProperties> = {
  cardLine: { margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: memberTheme.text },
  cardActions: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 },
  removeCardBtn: {
    ...destructiveButtonStyle,
    padding: '10px 16px', fontSize: 14, fontWeight: 600,
  },
  container: { padding: 16, maxWidth: 720, margin: '0 auto' },
  title: { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: memberTheme.title1 },
  card: { ...sectionCardStyle, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 },
  planName: { margin: 0, fontSize: 20, fontWeight: 700, color: memberTheme.text },
  planDesc: { margin: '4px 0 0', fontSize: 13, color: memberTheme.textMuted },
  dl: { margin: 0 },
  row: { ...rowDividerStyle, display: 'flex', justifyContent: 'space-between', padding: '8px 0' },
  dt: { margin: 0, fontSize: 13, color: memberTheme.textMuted },
  dd: { margin: 0, fontSize: 15, color: memberTheme.text, fontWeight: 500 },
  discount: { fontSize: 12, color: memberTheme.statusWarning, fontWeight: 400 },
  promoLine: { fontSize: 12, color: memberTheme.statusInfo, fontWeight: 400, marginTop: 2 },
  section: { marginTop: 24 },
  h2: { margin: '0 0 12px', fontSize: 16, fontWeight: 600, color: memberTheme.title2 },
  h3: { margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: memberTheme.title3 },
  benefitGroup: { marginBottom: 12 },
  benefitList: { listStyle: 'none', padding: 0, margin: 0 },
  benefitItem: { ...sectionCardStyle, borderRadius: 8, padding: '10px 14px', marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' },
  benefitMeta: { fontSize: 13, color: memberTheme.textMuted },
  eventList: { listStyle: 'none', padding: 0, margin: 0 },
  eventItem: { ...sectionCardStyle, borderRadius: 8, padding: '12px 14px', marginBottom: 6 },
  eventLine: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  eventLabel: { fontSize: 14, fontWeight: 500, color: memberTheme.text },
  eventAmount: { fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  eventSub: { fontSize: 12, color: memberTheme.textMuted, marginTop: 4 },
  receiptBtn: { background: 'none', border: 'none', padding: 0, color: memberTheme.link, textDecoration: 'underline', fontSize: 12, cursor: 'pointer' },
  emptyCard: { ...sectionCardStyle, padding: '40px 24px', textAlign: 'center' },
  emptyTitle: { margin: '8px 0 12px', fontSize: 20, fontWeight: 700 },
  hint: { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: 0 },
  // Payment banner
  paymentBanner: { ...noticeStyle('warning'), marginTop: 16, borderRadius: 12, padding: 16 },
  bannerContent: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  bannerHeading: { margin: 0, fontSize: 14, fontWeight: 600, color: 'inherit' },
  bannerAmount: { margin: '4px 0 0', fontSize: 20, fontWeight: 700, color: memberTheme.text },
  payNowBtn: { ...primaryButtonStyle, flexShrink: 0, padding: '10px 20px', fontSize: 14, fontWeight: 700 },
  startPaymentRow: { marginTop: 12, display: 'flex', justifyContent: 'flex-end' },
  startPaymentBtn: { ...secondaryButtonStyle, padding: '8px 16px', fontSize: 13 },
  // Consent modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 },
  modal: { ...sectionCardStyle, borderRadius: 16, padding: 24, maxWidth: 480, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' },
  modalTitle: { margin: '0 0 12px', fontSize: 18, fontWeight: 700, color: memberTheme.title2 },
  modalBody: { margin: '0 0 16px', fontSize: 14, color: memberTheme.textSecondary, lineHeight: 1.6 },
  checkLabel: { display: 'flex', alignItems: 'flex-start', fontSize: 13, color: memberTheme.text, cursor: 'pointer', marginBottom: 16 },
  submitError: { margin: '0 0 12px', fontSize: 13, color: memberTheme.statusError },
  modalActions: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  cancelBtn: { ...secondaryButtonStyle, padding: '10px 16px', fontSize: 14 },
  confirmBtn: { ...primaryButtonStyle, padding: '10px 20px', fontSize: 14, fontWeight: 600, transition: 'opacity 0.15s' },
};
