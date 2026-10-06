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
  memberTheme,
  noticeStyle,
  primaryButtonStyle,
  rowDividerStyle,
  secondaryButtonStyle,
  sectionCardStyle,
  statusPillStyle,
  statusTone,
} from '@/lib/memberChrome';
import {
  BillingEventCard,
  type BillingEventCardLine,
  PaymentsCard,
  PaymentsSubcard,
} from '@/components/MemberPaymentsCard';
import {
  MemberProductsSection,
  type MemberProductCardItem,
} from '@/components/MemberProductsSection';
import {
  PastMembershipPlansCard,
  type PastMembershipPlanItem,
} from '@/components/PastMembershipPlansCard';
import {
  type MemberPastPlan,
  pastPlanEndedOn,
  pastPlanName,
  pastPlanStatusKey,
} from '@/lib/memberPlans';
import {
  type MemberProduct,
  productFrequencyKey,
  productPackageNote,
  productPriceText,
  productTaxNoteKey,
} from '@/lib/memberProducts';
import {
  type BillingEventForecast,
  type ForecastDate,
  type ForecastLine,
  type MemberBillingEvent,
  EMPTY_FORECAST,
  billingEventAmount,
  forecastDatesAfterNext,
  formatPaymentAmount,
  formatPaymentDate,
  lineKindKey,
  lineTreatmentKey,
  lineTreatmentName,
  nextPaymentDate,
  pastBillingEventGroups,
  showsRegularPrice,
} from '@/lib/memberPayments';

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
  /**
   * #635 stage 12 — still served by `GET /me/membership`, and no longer read
   * here: #1123's Payments card takes the next charge from the Billing Event
   * Forecast, which carries the lines that make it up as well as the total.
   */
  upcoming_payments: unknown[];
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

/**
 * #1123 — the ledger row the Payments card's *Past Billing Events* subcard
 * lists. Its `status` is derived by the API's one implementation (#640), so this
 * page never asks whether a charge was paid.
 */
type BillingEvent = MemberBillingEvent;

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
  const { isLinked, loading: appLoading, gymName, isSuperadmin } = useApp();
  const { isImpersonating } = useImpersonation();
  const { flags: featureFlags } = useFeatureFlags();

  const [membership, setMembership] = useState<Membership | null>(null);
  // #1122 §7 — the member's finished plans, which the server splits off the one
  // ordering that decides which assignment the card above is about, so this page
  // never filters a list by status for itself.
  const [pastPlans, setPastPlans] = useState<MemberPastPlan[]>([]);
  const [packages, setPackages] = useState<UserPackage[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [events, setEvents] = useState<BillingEvent[]>([]);
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  // #1123 — the one projection both the Next Payment and the Forecast subcards
  // read. A member with no plan, or one that bills nothing further, answers
  // `available: false` rather than an error, so a failed fetch is the only thing
  // that falls back to the empty shape.
  const [forecast, setForecast] = useState<BillingEventForecast>(EMPTY_FORECAST);
  // #1121 stage 1 — the gym's own catalogue, read-only. `null` means the
  // catalogue could not be read at all (a gym with `financials.products`
  // switched off answers 403), and the subsection is then **absent** rather than
  // claiming a gym offers nothing — the same distinction the forecast draws with
  // `available`, and #1073's "a control that cannot work is absent, never
  // broken". An empty array is a gym that really has nothing public yet.
  const [products, setProducts] = useState<MemberProduct[] | null>(null);
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
        const [mship, ledger, pkgs, promos, prs, projection, catalogue] = await Promise.all([
          apiFetch<{ membership: Membership | null; past_memberships?: MemberPastPlan[] }>('/me/membership'),
          apiFetch<{ items: BillingEvent[] }>('/me/billing-events?limit=50'),
          apiFetch<UserPackage[]>('/me/class-packages').catch(() => []),
          apiFetch<Promotion[]>('/me/promotions').catch(() => []),
          apiFetch<PaymentRequest[]>('/me/payment-requests').catch(() => []),
          apiFetch<BillingEventForecast>('/me/billing-event-forecast').catch(() => EMPTY_FORECAST),
          apiFetch<{ items: MemberProduct[] }>('/me/products').catch(() => null),
        ]);
        if (cancelled) return;
        setMembership(mship.membership);
        setPastPlans(mship.past_memberships ?? []);
        setEvents(ledger.items);
        setPackages(pkgs);
        setPromotions(promos);
        setPaymentRequests(prs);
        setForecast(projection);
        setProducts(catalogue?.items ?? null);
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

  function openConsent() {
    setConsentChecked(false);
    setSubmitError(null);
    setConsentOpen(true);
  }

  /* ── #1123 Payments ─────────────────────────────────────────────────────── */
  //
  // Which rows belong to which subcard is `lib/memberPayments.ts`' decision; the
  // page's only job is to resolve the labels and hand the component strings it
  // can render. No amount is computed here — every figure below is the server's,
  // formatted.

  const nextGroup = nextPaymentDate(forecast);
  const laterGroups = forecastDatesAfterNext(forecast);
  const pastGroups = pastBillingEventGroups(events);

  const money = (amount: number | null) => formatPaymentAmount(amount, forecast.currency, locale);

  /** Why a forecast line is not at its regular price, named with its Promotion. */
  function treatmentLabel(line: ForecastLine): string | null {
    const key = lineTreatmentKey(line);
    if (!key) return null;
    const benefit = line.benefits.find((b) => b.action !== 'no_benefit');
    // A percentage is a number; a fixed discount or price is money, so it is
    // written the way every other amount on this card is.
    const value = benefit?.action === 'percentage_discount'
      ? String(benefit.value ?? '')
      : benefit?.value != null ? (money(benefit.value) ?? String(benefit.value)) : '';
    const label = t(`payments.${key}` as any, { value });
    const name = lineTreatmentName(line);
    return name ? `${label} · ${name}` : label;
  }

  function forecastCardLines(group: ForecastDate): BillingEventCardLine[] {
    return group.lines.map((line, index) => {
      const meta = [
        line.quantity > 1 ? t('payments.quantity', { count: line.quantity }) : null,
        treatmentLabel(line),
        // #946 — the one line that collects a Pre-paid Duration up front says how
        // many periods its amount covers, because the periods after it charge
        // nothing and an unexplained multiple of the fee reads as an error.
        line.prepaid_periods != null
          ? t('payments.prepaid_periods', { count: line.prepaid_periods })
          : null,
      ].filter(Boolean).join(' · ');
      return {
        key: `${line.kind}-${line.product_id ?? 'fee'}-${index}`,
        heading: t(`payments.${lineKindKey(line)}` as any),
        name: line.label,
        meta: meta || null,
        amount: money(line.actual_charge),
        // Only where the two differ: `€50.00 → €50.00` on every ordinary cycle
        // is a line of the breakdown spent saying nothing.
        regularAmount: showsRegularPrice(line) ? money(line.regular_price) : null,
      };
    });
  }

  /* ── #1121 Additional Products and Services ─────────────────────────────── */
  //
  // Which key a line reads under is `lib/memberProducts.ts`' decision and the
  // card is `MemberProductsSection`'s; the page resolves the keys, exactly as it
  // does for the Payments card above. No amount is computed here.

  /**
   * The subsection, or nothing at all for a catalogue that could not be read.
   * One function because two branches of this page render it — a member with a
   * plan and one without — and two copies would drift.
   */
  function renderProducts() {
    if (products === null) return null;
    return (
      <MemberProductsSection
        title={t('membership.products_heading')}
        emptyLabel={t('membership.products_empty')}
        items={productCardItems(products)}
      />
    );
  }

  /* ── #1122 Past Membership Plans ────────────────────────────────────────── */

  function pastPlanItems(plans: MemberPastPlan[]): PastMembershipPlanItem[] {
    return plans.map((plan) => {
      const endedOn = pastPlanEndedOn(plan, locale);
      const status = t(pastPlanStatusKey(plan) as any);
      return {
        key: String(plan.id),
        name: pastPlanName(plan),
        // A row with no end date on file reads as its status alone, rather than
        // as a date the assignment does not actually carry.
        meta: endedOn ? `${status} · ${endedOn}` : status,
      };
    });
  }

  /**
   * The history card, or nothing at all for a member who has none — a collapsed
   * card that opens onto an empty list is vertical space spent saying nothing,
   * which is what §8 asks this section not to do.
   */
  function renderPastPlans() {
    if (pastPlans.length === 0) return null;
    return (
      <PastMembershipPlansCard
        title={t('membership.past_plans_heading')}
        summary={t('membership.past_plans_count', { count: pastPlans.length })}
        items={pastPlanItems(pastPlans)}
      />
    );
  }

  function productCardItems(items: MemberProduct[]): MemberProductCardItem[] {
    return items.map((product) => {
      const frequencyKey = productFrequencyKey(product);
      const packageNote = productPackageNote(product);
      const taxKey = productTaxNoteKey(product);
      const meta = [
        packageNote ? t(packageNote.key as any, packageNote.values) : null,
        taxKey ? t(taxKey as any) : null,
      ].filter(Boolean).join(' · ');
      return {
        key: String(product.id),
        name: product.name,
        description: product.description,
        price: productPriceText(product, locale),
        frequency: frequencyKey ? t(frequencyKey as any) : null,
        meta: meta || null,
      };
    });
  }

  function pastCardLines(group: BillingEvent[]): BillingEventCardLine[] {
    return group.map((event) => {
      const transition = event.event_type === 'status_changed' && event.new_status
        ? `${event.previous_status ? t(`membership.status.${event.previous_status}` as any) : '—'}`
          + ` → ${t(`membership.status.${event.new_status}` as any)}`
        : null;
      return {
        key: String(event.id),
        name: t(`membership.event.${event.event_type}` as any)
          + (event.charge_type_code ? ` · ${t(`membership.charge_type.${event.charge_type_code}` as any)}` : ''),
        meta: [transition, event.notes].filter(Boolean).join(' · ') || null,
        amount: money(billingEventAmount(event)),
        trailing: (
          <>
            {/* The status is the event's own, derived once by the API (#640) —
                a date carrying a settled charge and a rejected one must not be
                summarised into a single verdict. */}
            <span style={statusPillStyle(statusTone(event.status))}>
              {t(`payments.status.${event.status}` as any)}
            </span>
            {/* #787 — the receipt number is the gate: the server allocates one
                only for a payment that was received. */}
            {event.receipt_number && (
              <button
                onClick={() => downloadReceipt(event.id)}
                disabled={downloadingReceipt === event.id}
                style={styles.receiptBtn}
              >
                {downloadingReceipt === event.id
                  ? '…'
                  : `${t('membership.download_receipt')} (${event.receipt_number})`}
              </button>
            )}
          </>
        ),
      };
    });
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
    // A member may hold no plan at all (#956), and the catalogue is the gym's
    // rather than the plan's — so the products still belong on this screen.
    return (
      <main style={styles.container}>
        <div style={styles.emptyCard}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✦</div>
          <h1 style={styles.emptyTitle}>{t('membership.title')}</h1>
          <p style={styles.hint}>{t('membership.empty')}</p>
        </div>
        {renderProducts()}
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

      {/* #1122 §7 — Past Membership Plans, directly under the current plan and
          its own payment banner: it belongs to the Membership Plans group of
          this page rather than beside the catalogue, and it is collapsed, so it
          costs one line of vertical space before anything else is pushed down. */}
      {renderPastPlans()}

      {/* #1121 §3 — Additional Products and Services, directly below the
          membership card. The payment banner and Start payment above it belong
          to that card (they are about the fee it charges), so the subsection
          follows them rather than splitting the membership from its own
          pending payment. */}
      {renderProducts()}

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

      {/* #1123 — Payments: one collapsed card holding Next Payment, Past
          Billing Events and Forecast Billing Events. It replaces the page's
          own *Upcoming payments* and *Payment history* sections: both are
          absorbed, so neither the ledger nor a projected charge is rendered
          twice. */}
      <PaymentsCard
        title={t('payments.title')}
        summary={nextGroup
          ? t('payments.summary_next', {
            date: formatPaymentDate(nextGroup.date, locale),
            amount: money(nextGroup.total) ?? '—',
          })
          : null}
      >
        <PaymentsSubcard title={t('payments.next_heading')} defaultOpen>
          {nextGroup ? (
            <BillingEventCard
              date={formatPaymentDate(nextGroup.date, locale)}
              total={money(nextGroup.total)}
              totalLabel={t('payments.total')}
              lines={forecastCardLines(nextGroup)}
              prominent
              footer={forecast.tax_included ? t('payments.tax_included') : null}
            />
          ) : (
            <p style={styles.hint}>{t('payments.next_empty')}</p>
          )}
        </PaymentsSubcard>

        <PaymentsSubcard title={t('payments.past_heading')}>
          {pastGroups.length === 0 ? (
            <p style={styles.hint}>{t('payments.past_empty')}</p>
          ) : (
            pastGroups.map((group) => (
              <BillingEventCard
                key={group.date}
                date={formatPaymentDate(group.date, locale)}
                total={money(group.total)}
                totalLabel={t('payments.total')}
                lines={pastCardLines(group.events)}
              />
            ))
          )}
        </PaymentsSubcard>

        <PaymentsSubcard title={t('payments.forecast_heading')}>
          {laterGroups.length === 0 ? (
            <p style={styles.hint}>
              {forecast.available ? t('payments.forecast_empty') : t('payments.forecast_unavailable')}
            </p>
          ) : (
            laterGroups.map((group) => (
              <BillingEventCard
                key={group.date}
                date={formatPaymentDate(group.date, locale)}
                total={money(group.total)}
                totalLabel={t('payments.total')}
                lines={forecastCardLines(group)}
                badge={<span style={statusPillStyle('info')}>{t('payments.forecast_badge')}</span>}
              />
            ))
          )}
        </PaymentsSubcard>
      </PaymentsCard>

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

// #983 — the pill reads its tone from `lib/memberChrome.ts`, which is also
// where the dashboard and My Bookings read theirs: the same status must not be
// one colour here and another there.
function StatusPill({ status, label }: { status: string; label: string }) {
  return <span style={{ ...statusPillStyle(statusTone(status)), padding: '4px 12px' }}>{label}</span>;
}

const styles: Record<string, React.CSSProperties> = {
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
