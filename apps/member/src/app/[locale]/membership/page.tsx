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
  type MemberProductCardPromotion,
} from '@/components/MemberProductsSection';
import { SERVICE_FILTER_PARAM, serviceFilterFromParam } from '@/lib/serviceRequired';
import { MemberDialog } from '@/components/MemberDialog';
import { MemberPlanCatalogue, type MemberPlanCardItem } from '@/components/MemberPlanCatalogue';
import {
  type MemberPendingPlan,
  type MemberPlanOffer,
  assignErrorKey,
  choosingOwesNothing,
  planFinalPriceText,
  planFrequencyKey,
  planPriceText,
  planPromotionBenefitNote,
  planPromotionDurationNote,
} from '@/lib/memberPlanCatalogue';
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
  type AppliedMemberProductPromotion,
  type MemberProduct,
  type MemberProductPromotion,
  productFinalPriceText,
  productFrequencyKey,
  productPackageNote,
  productPriceText,
  productTaxNoteKey,
  isMembershipFeeRequest,
  promotionBenefitNote,
  promotionDurationNote,
  purchaseErrorKey,
  purchaseStateKey,
  purchaseStateStatusWord,
  showsBuyAction,
  showsRegularProductPrice,
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
  /**
   * #1121 stage 2 — which flow raised it. A product purchase is a real payment
   * and belongs in the member's history, but it is not the **membership fee**,
   * so the "you have a payment to finish" prompt below must not read one as an
   * unpaid fee (migration 228's reason, and #788's one flow over).
   */
  source: string;
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
  // #1189 stage 4 — set when a refused booking sent the member here: only the
  // Products that grant sessions of those Professional Services are listed.
  const [serviceFilter, setServiceFilter] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [downloadingReceipt, setDownloadingReceipt] = useState<number | null>(null);

  // #1121 stage 2 — the Product the member is confirming, and that one
  // dialog's own submit state. `null` means no dialog.
  const [purchasing, setPurchasing] = useState<MemberProduct | null>(null);
  const [purchaseSubmitting, setPurchaseSubmitting] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  /**
   * #1118 §5 — the Promotion the member has applied, per Product.
   *
   * It is page state and nothing more: applying one recalculates the Final
   * price from the figure the server already quoted and persists nothing, and
   * the **snapshot** is written by the purchase itself (§7 binds it to "the
   * resulting purchase", so there is nothing for it to hang off before one
   * exists). The id travels to `POST /me/products/:id/purchase`, which re-reads
   * and re-prices it server-side — the browser never names a price.
   */
  const [appliedPromotions, setAppliedPromotions] = useState<Record<number, number>>({});

  // #1122 §1–§6 — Add Plan. The catalogue is read when the member opens it,
  // the Promotion applied per plan is page state (its snapshot is written by
  // the assignment itself, §5/§6), and the plan awaiting its first payment is
  // what the server reports beside the current one (#1108 stage 2).
  const [pendingMembership, setPendingMembership] = useState<MemberPendingPlan | null>(null);
  const [planCatalogue, setPlanCatalogue] = useState<MemberPlanOffer[] | null>(null);
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [catalogueLoading, setCatalogueLoading] = useState(false);
  const [appliedPlanPromotions, setAppliedPlanPromotions] = useState<Record<number, number>>({});
  const [choosingPlan, setChoosingPlan] = useState<MemberPlanOffer | null>(null);
  const [assignSubmitting, setAssignSubmitting] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignNeedsConfirm, setAssignNeedsConfirm] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    if (!(isSuperadmin && !isImpersonating) && !isFeatureEnabled(featureFlags, 'member_web.my_membership')) { router.replace(`/${locale}`); return; }
    let cancelled = false;
    // Read off the address bar rather than `useSearchParams()`, which would
    // need a Suspense boundary around this whole page.
    const filter = serviceFilterFromParam(new URLSearchParams(window.location.search).get(SERVICE_FILTER_PARAM));
    setServiceFilter(filter);
    (async () => {
      try {
        const [mship, ledger, pkgs, promos, prs, projection, catalogue] = await Promise.all([
          apiFetch<{ membership: Membership | null; past_memberships?: MemberPastPlan[]; pending_membership?: MemberPendingPlan | null }>('/me/membership'),
          apiFetch<{ items: BillingEvent[] }>('/me/billing-events?limit=50'),
          apiFetch<UserPackage[]>('/me/class-packages').catch(() => []),
          apiFetch<Promotion[]>('/me/promotions').catch(() => []),
          apiFetch<PaymentRequest[]>('/me/payment-requests').catch(() => []),
          apiFetch<BillingEventForecast>('/me/billing-event-forecast').catch(() => EMPTY_FORECAST),
          apiFetch<{ items: MemberProduct[] }>('/me/products' + (filter.length ? `?${SERVICE_FILTER_PARAM}=${filter.join(',')}` : '')).catch(() => null),
        ]);
        if (cancelled) return;
        setMembership(mship.membership);
        setPastPlans(mship.past_memberships ?? []);
        setPendingMembership(mship.pending_membership ?? null);
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
  }, [appLoading, isLinked, locale, isSuperadmin, isImpersonating, featureFlags, reloadKey]);

  const pendingRequest = paymentRequests
    .find(r => r.status === 'pending' && isMembershipFeeRequest(r.source)) ?? null;
  const showStartPayment = !pendingRequest
    && membership?.status === 'active'
    && membership?.membership_fee != null
    && membership.membership_fee > 0;

  // Resolve amount and interval shown in the consent modal
  // #1108 stage 2: the plan awaiting its first payment is what Pay now is
  // for while one exists — `POST /me/payment-requests` picks it ahead of an
  // active plan for the same reason.
  const consentAmount = pendingRequest
    ? parseFloat(pendingRequest.amount).toFixed(2)
    : pendingMembership?.membership_fee != null ? pendingMembership.membership_fee.toFixed(2)
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
      <>
      {serviceFilter.length > 0 && (
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>
          {t('membership.products_filtered_notice')}{' '}
          <a
            href={`/${locale}/membership`}
            style={{ color: 'inherit', textDecoration: 'underline' }}
          >
            {t('membership.products_show_all')}
          </a>
        </p>
      )}
      <MemberProductsSection
        title={t('membership.products_heading')}
        emptyLabel={t('membership.products_empty')}
        items={productCardItems(products)}
      />
      </>
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
      const applied = appliedPromotionFor(product);
      return {
        key: String(product.id),
        name: product.name,
        description: product.description,
        // §5: the Final price, which is the applied Promotion's own figure —
        // the server's, never recomputed here (#817).
        price: productFinalPriceText(product, applied, locale),
        regularPrice: showsRegularProductPrice(product, applied)
          ? productPriceText(product, locale)
          : null,
        frequency: frequencyKey ? t(frequencyKey as any) : null,
        meta: meta || null,
        promotions: productPromotions(product, applied),
        action: productAction(product),
      };
    });
  }

  /* ── #1118 Promotions on a Product ──────────────────────────────────────── */

  /** The offer the member has applied to this Product in the page, if any. */
  function appliedPromotionFor(product: MemberProduct): MemberProductPromotion | null {
    const promotionId = appliedPromotions[product.id];
    if (promotionId == null) return null;
    return (product.promotions ?? []).find((p) => p.promotion_id === promotionId) ?? null;
  }

  /**
   * The Promotion blocks under a Product (§4), or the one it was bought under
   * (§13).
   *
   * A purchased or pending Product has no offers left — the server stops
   * sending them — so what it shows instead is its own frozen application,
   * read-only and with no action: there is nothing left to apply.
   */
  function productPromotions(
    product: MemberProduct, applied: MemberProductPromotion | null,
  ): MemberProductCardPromotion[] {
    if (product.applied_promotion) return [appliedPromotionCard(product.applied_promotion, product)];
    return (product.promotions ?? []).map((promotion) => {
      const isApplied = applied?.promotion_id === promotion.promotion_id;
      return {
        key: String(promotion.promotion_id),
        heading: t('membership.promotion_heading'),
        name: promotion.promotion_name,
        benefit: promotionNoteText(
          promotionBenefitNote(promotion.action, promotion.value, product.currency, locale),
        ),
        duration: promotionNoteText(promotionDurationNote(promotion.duration_cycles)),
        action: isApplied ? (
          // §5.5 — applied reads as a statement, not as a button that undoes
          // itself: the member clears it by applying another or by not buying.
          <span style={styles.promotionApplied}>{t('membership.promotion_applied')}</span>
        ) : (
          <button
            type="button"
            style={styles.promotionBtn}
            onClick={() => applyPromotion(product, promotion)}
          >
            {t('membership.promotion_apply')}
          </button>
        ),
      };
    });
  }

  /** The Promotion a live purchase was made under — the snapshot, never a live read. */
  function appliedPromotionCard(
    promotion: AppliedMemberProductPromotion, product: MemberProduct,
  ): MemberProductCardPromotion {
    return {
      key: `applied-${promotion.id}`,
      heading: t('membership.promotion_heading'),
      name: promotion.promotion_name,
      benefit: promotionNoteText(
        promotionBenefitNote(
          promotion.benefit_action, promotion.benefit_value, product.currency, locale,
        ),
      ),
      duration: promotionNoteText(promotionDurationNote(promotion.duration_cycles)),
      action: <span style={styles.promotionApplied}>{t('membership.promotion_applied')}</span>,
    };
  }

  /** A note the lib decided, resolved — `null` stays `null` rather than a key. */
  function promotionNoteText(note: { key: string; values?: Record<string, string | number> } | null) {
    return note ? t(note.key as any, note.values) : null;
  }

  /**
   * Applying one is presentation plus one id: the price the card shows becomes
   * the offer's own, and nothing is written until the member buys.
   */
  function applyPromotion(product: MemberProduct, promotion: MemberProductPromotion) {
    setAppliedPromotions((current) => ({ ...current, [product.id]: promotion.promotion_id }));
  }

  /**
   * #1121 stage 2 §6 — the card's one action: Buy, or what the member already
   * holds.
   *
   * Which of the two (and whether either) is `lib/memberProducts.ts`' answer
   * over the server's `purchasable`/`purchase_state`, so a Product stage 2
   * cannot sell — a recurring one, an unpriced one — gets **nothing** rather
   * than a disabled button (#1073). The pill's tone is `statusTone()`'s, the
   * app's one map (#983).
   */
  function productAction(product: MemberProduct) {
    if (showsBuyAction(product)) {
      return (
        <button
          type="button"
          style={styles.buyBtn}
          onClick={() => openPurchase(product)}
        >
          {t('membership.product_buy')}
        </button>
      );
    }
    const stateKey = purchaseStateKey(product.purchase_state);
    const statusWord = purchaseStateStatusWord(product.purchase_state);
    if (!stateKey || !statusWord) return null;
    return <StatusPill status={statusWord} label={t(stateKey as any)} />;
  }

  function openPurchase(product: MemberProduct) {
    setPurchaseError(null);
    setPurchasing(product);
  }

  function closePurchase() {
    setPurchasing(null);
    setPurchaseError(null);
  }

  /**
   * Starts the purchase and hands the member to the hosted page, exactly as the
   * membership fee's own consent flow does — the card is typed on
   * `pay.<host>`, never here (the Admin and Members apps never see card data).
   */
  async function confirmPurchase(product: MemberProduct) {
    setPurchaseSubmitting(true);
    setPurchaseError(null);
    try {
      const applied = appliedPromotionFor(product);
      const result = await apiFetch<{ checkoutUrl: string }>(
        `/me/products/${product.id}/purchase`,
        {
          method: 'POST',
          // The id alone: the route re-reads and re-prices the Promotion, so a
          // price named here would be ignored (§8) — and one that has lapsed in
          // the meantime refuses the purchase rather than charging another.
          body: JSON.stringify(applied ? { promotion_id: applied.promotion_id } : {}),
        },
      );
      window.location.href = result.checkoutUrl;
    } catch (err: any) {
      // The API answers the refusal code, so the member reads it in their own
      // language; anything else falls back to the generic key.
      setPurchaseError(t(purchaseErrorKey(err?.message) as any));
      setPurchaseSubmitting(false);
    }
  }

  // ── #1122 — Add Plan ──────────────────────────────────────────────────────

  async function openCatalogue() {
    setCatalogueOpen(true);
    if (planCatalogue !== null) return;
    setCatalogueLoading(true);
    try {
      const res = await apiFetch<{ plans: MemberPlanOffer[] }>('/me/membership-plans');
      setPlanCatalogue(res.plans);
    } catch {
      setPlanCatalogue([]);
    } finally {
      setCatalogueLoading(false);
    }
  }

  function applyPlanPromotion(planId: number, promotionId: number) {
    setAppliedPlanPromotions((prev) => ({ ...prev, [planId]: promotionId }));
  }

  function openChoosePlan(plan: MemberPlanOffer) {
    setChoosingPlan(plan);
    setAssignError(null);
    setAssignNeedsConfirm(false);
  }

  function closeChoosePlan() {
    setChoosingPlan(null);
    setAssignError(null);
    setAssignNeedsConfirm(false);
  }

  /**
   * `POST /me/membership-plans/:id/assign` — the member's own Draft, the
   * applied Promotion with its snapshot, then Save & Pay. A 409 `active_plan_exists`
   * is the one-plan rule asking for the replacement to be confirmed, so the
   * dialog turns into that question and resends with `confirm: true`.
   */
  async function confirmChoosePlan(confirmReplacement = false) {
    if (!choosingPlan) return;
    setAssignSubmitting(true);
    setAssignError(null);
    try {
      const applied = appliedPlanPromotions[choosingPlan.id] ?? null;
      await apiFetch(`/me/membership-plans/${choosingPlan.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          promotion_ids: applied ? [applied] : [],
          ...(confirmReplacement ? { confirm: true } : {}),
        }),
      });
      closeChoosePlan();
      setCatalogueOpen(false);
      setReloadKey((k) => k + 1);
    } catch (err: any) {
      if (err?.message === 'active_plan_exists' && !confirmReplacement) {
        setAssignNeedsConfirm(true);
      } else {
        setAssignError(t(assignErrorKey(err?.message) as any));
      }
    } finally {
      setAssignSubmitting(false);
    }
  }

  /**
   * The *Add plan* action and, while one exists, the plan awaiting its first
   * payment — above the current plan (§1), in both the with-plan and the
   * no-plan branches so the entry point is never missing.
   */
  function renderPlansHeader() {
    return (
      <>
        {pendingMembership && (
          <div style={styles.pendingPlanCard}>
            <p style={styles.pendingPlanHeading}>{t('membership.pending_plan_heading')}</p>
            <p style={styles.pendingPlanBody}>
              {t('membership.pending_plan_body', {
                name: pendingMembership.plan_name ?? '—',
                price: pendingMembership.membership_fee != null ? pendingMembership.membership_fee.toFixed(2) : '—',
              })}
            </p>
            <div style={styles.pendingPlanAction}>
              <button type="button" style={primaryButtonStyle} onClick={openConsent}>
                {t('membership.pending_plan_pay')}
              </button>
            </div>
          </div>
        )}
        {!pendingMembership && !catalogueOpen && (
          <div style={styles.addPlanRow}>
            <button type="button" style={primaryButtonStyle} onClick={openCatalogue}>
              {t('membership.add_plan')}
            </button>
          </div>
        )}
      </>
    );
  }

  function renderPlanCatalogue() {
    if (!catalogueOpen) return null;
    const items: MemberPlanCardItem[] = (planCatalogue ?? []).map((plan) => {
      const applied = appliedPlanPromotions[plan.id] ?? null;
      const frequencyKey = planFrequencyKey(plan);
      return {
        key: String(plan.id),
        name: plan.name,
        description: plan.description,
        price: planPriceText(plan, locale),
        frequency: frequencyKey
          ? t(frequencyKey as any)
          : (plan.billing_interval != null && plan.billing_unit ? formatInterval(plan.billing_interval, plan.billing_unit, t) : null),
        finalPriceLabel: t('membership.plan_final_price'),
        finalPrice: applied ? planFinalPriceText(plan, applied, locale) : null,
        promotions: plan.promotions.map((promotion) => {
          const benefit = planPromotionBenefitNote(promotion, locale);
          const duration = planPromotionDurationNote(promotion);
          const isApplied = applied === promotion.id;
          return {
            key: String(promotion.id),
            heading: t('membership.promotion_heading'),
            name: promotion.name,
            benefit: benefit ? t(benefit.key as any, benefit.values) : null,
            duration: duration ? t(duration.key as any, duration.values) : null,
            action: isApplied
              ? <span style={statusPillStyle(statusTone('active'))}>{t('membership.promotion_applied')}</span>
              : (
                <button type="button" style={secondaryButtonStyle} onClick={() => applyPlanPromotion(plan.id, promotion.id)}>
                  {t('membership.promotion_apply')}
                </button>
              ),
          };
        }),
        action: (
          <button type="button" style={primaryButtonStyle} onClick={() => openChoosePlan(plan)}>
            {t('membership.choose_plan')}
          </button>
        ),
      };
    });
    return (
      <>
        <MemberPlanCatalogue
          title={t('membership.add_plan_title')}
          emptyLabel={catalogueLoading ? t('membership.add_plan_loading') : t('membership.add_plan_empty')}
          items={items}
          onClose={() => setCatalogueOpen(false)}
          closeLabel={t('membership.add_plan_close')}
        />
        {choosingPlan && (
          <MemberDialog
            title={t('membership.choose_plan_title')}
            onClose={assignSubmitting ? () => {} : closeChoosePlan}
            labelledBy="choose-plan-title"
            actions={(
              <>
                <button type="button" style={secondaryButtonStyle} onClick={closeChoosePlan} disabled={assignSubmitting}>
                  {t('membership.choose_plan_cancel')}
                </button>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  onClick={() => confirmChoosePlan(assignNeedsConfirm)}
                  disabled={assignSubmitting}
                >
                  {assignSubmitting
                    ? t('membership.choose_plan_submitting')
                    : assignNeedsConfirm ? t('membership.add_plan_replace_confirm') : t('membership.choose_plan_confirm')}
                </button>
              </>
            )}
          >
            {assignNeedsConfirm ? (
              <p style={styles.dialogBody}>
                {t('membership.add_plan_replace_body', { current: membership?.plan_name ?? '—', name: choosingPlan.name })}
              </p>
            ) : (
              <p style={styles.dialogBody}>
                {choosingOwesNothing(choosingPlan, appliedPlanPromotions[choosingPlan.id] ?? null)
                  ? t('membership.choose_plan_body_free', { name: choosingPlan.name })
                  : t('membership.choose_plan_body', {
                    name: choosingPlan.name,
                    price: planFinalPriceText(choosingPlan, appliedPlanPromotions[choosingPlan.id] ?? null, locale) ?? '—',
                  })}
              </p>
            )}
            {assignError && <p style={{ ...styles.dialogBody, color: memberTheme.statusError }}>{assignError}</p>}
          </MemberDialog>
        )}
      </>
    );
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
        {renderPlansHeader()}
        {renderPlanCatalogue()}
        {!pendingMembership && !catalogueOpen && (
          <div style={styles.emptyCard}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>✦</div>
            <h1 style={styles.emptyTitle}>{t('membership.title')}</h1>
            <p style={styles.hint}>{t('membership.empty')}</p>
          </div>
        )}
        {renderProducts()}
      </main>
    );
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('membership.title')}</h1>

      {/* #1122 §1 — Add plan above the current plan, and the plan awaiting
          its first payment while one exists. */}
      {renderPlansHeader()}
      {renderPlanCatalogue()}

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

      {/* #1121 stage 2 §5/§8 — the member sees the final price before paying, in
          the app's own dialog (#1115: one dialog shell, not a second overlay).
          It asks nothing: the price, the frequency and the package note are the
          ones the card already showed, resolved once above. */}
      {purchasing && (
        <MemberDialog
          labelledBy="product-purchase-title"
          title={t('membership.product_purchase_title')}
          onClose={purchaseSubmitting ? () => {} : closePurchase}
          actions={(
            <>
              <button
                type="button"
                style={styles.dialogSecondary}
                onClick={closePurchase}
                disabled={purchaseSubmitting}
              >
                {t('membership.product_purchase_cancel')}
              </button>
              <button
                type="button"
                style={{ ...styles.dialogPrimary, ...(purchaseSubmitting ? styles.busy : null) }}
                onClick={() => confirmPurchase(purchasing)}
                disabled={purchaseSubmitting}
              >
                {purchaseSubmitting
                  ? t('membership.product_purchase_submitting')
                  : t('membership.product_purchase_confirm')}
              </button>
            </>
          )}
        >
          <p style={styles.modalBody}>
            {/* §8: the member must always see the **actual** final price before
                completing the purchase — so the dialog quotes the price with
                their applied Promotion, exactly as the card does. */}
            {t('membership.product_purchase_body', {
              name: purchasing.name,
              price: productFinalPriceText(purchasing, appliedPromotionFor(purchasing), locale) ?? '—',
            })}
          </p>
          <p style={styles.hintLeft}>{t('membership.product_purchase_once')}</p>
          {purchaseError && <p style={styles.submitError}>{purchaseError}</p>}
        </MemberDialog>
      )}

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
  title: { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
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
  h2: { margin: '0 0 12px', fontSize: 16, fontWeight: 600, color: memberTheme.title2, fontFamily: memberTheme.title2Font },
  h3: { margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: memberTheme.title3, fontFamily: memberTheme.title3Font },
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
  // #1122 — the Add plan row, the plan awaiting its first payment, and the
  // choose dialog's text. Every colour is the theme's (#983).
  addPlanRow: { display: 'flex', justifyContent: 'flex-end', marginBottom: 12 },
  pendingPlanCard: { ...noticeStyle('warning'), marginBottom: 12 },
  pendingPlanHeading: { margin: 0, fontSize: 13, fontWeight: 700 },
  pendingPlanBody: { margin: '4px 0 0', fontSize: 13 },
  pendingPlanAction: { display: 'flex', justifyContent: 'flex-end', marginTop: 10 },
  dialogBody: { margin: '0 0 8px', fontSize: 14, color: memberTheme.text, lineHeight: 1.5 },
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
  modalTitle: { margin: '0 0 12px', fontSize: 18, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font },
  modalBody: { margin: '0 0 16px', fontSize: 14, color: memberTheme.textSecondary, lineHeight: 1.6 },
  checkLabel: { display: 'flex', alignItems: 'flex-start', fontSize: 13, color: memberTheme.text, cursor: 'pointer', marginBottom: 16 },
  submitError: { margin: '0 0 12px', fontSize: 13, color: memberTheme.statusError },
  modalActions: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  cancelBtn: { ...secondaryButtonStyle, padding: '10px 16px', fontSize: 14 },
  // #1121 stage 2 — the Buy action and the purchase dialog's own pair. Both
  // spread `memberChrome`'s buttons; neither spells a colour (#983).
  buyBtn: { ...primaryButtonStyle, padding: '8px 18px', fontSize: 13.5, fontWeight: 600 },
  // #1118 §4/§17 — *Apply promotion* is an obvious action but a secondary one:
  // Buy is the card's primary, and two filled buttons on one card compete. Both
  // come from `memberChrome.ts`, so neither spells a colour (#983).
  promotionBtn: { ...secondaryButtonStyle, padding: '7px 14px', fontSize: 13, fontWeight: 600 },
  promotionApplied: { fontSize: 13, fontWeight: 600, color: memberTheme.textSecondary },
  dialogPrimary: { ...primaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 },
  dialogSecondary: { ...secondaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 },
  busy: { opacity: 0.6, cursor: 'default' },
  hintLeft: { margin: 0, fontSize: 12.5, color: memberTheme.textMuted },
  confirmBtn: { ...primaryButtonStyle, padding: '10px 20px', fontSize: 14, fontWeight: 600, transition: 'opacity 0.15s' },
};
