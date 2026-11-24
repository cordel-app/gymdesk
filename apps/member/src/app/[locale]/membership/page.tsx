'use client';

import { formatGymDateOnly, formatGymTime } from '@/lib/gymFormat';
import { formatDraftRemaining, isDraftWarning, isExpiredDraft, showsDraftExactTime } from '@/lib/draftCountdown';
import { useDraftCountdown } from '@/lib/useDraftCountdown';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { ADD_PLAN_PATH, ADD_PRODUCT_PATH, FAMILY_OWNER_ONLY_KEY, MEMBERSHIP_PATH, canAddPlansAndProducts, canViewPayments, membershipPageMode, membershipTabs } from '@/lib/membershipPages';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import {
  cartDividerStyle,
  cartHeadingStyle,
  cartMutedStyle,
  cartSecondaryButtonStyle,
  cartSummaryStyle,
  cartTotalStyle,
  inputStyle,
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
  BillingEventBadges,
  BillingEventCard,
  type BillingEventCardLine,
  PaymentsSection,
  PaymentsSubcard,
  PastBillingEventRow,
  PaymentDocumentList,
} from '@/components/MemberPaymentsCard';
import {
  MemberProductsSection,
  type MemberProductCardItem,
  type MemberProductCardPromotion,
} from '@/components/MemberProductsSection';
import { SERVICE_FILTER_PARAM, productsPathForServices, serviceFilterFromParam, serviceFilterSelectValue, type ServiceOption } from '@/lib/serviceRequired';

/** #2905 — `GET /me/products`, narrowed to the services named (none: the whole catalogue). */
function productsQuery(ids: number[]): string {
  return '/me/products' + (ids.length ? `?${SERVICE_FILTER_PARAM}=${ids.join(',')}` : '');
}
import {
  type CartItem,
  type MemberCartView,
  type MemberStandaloneCart,
  EMPTY_STANDALONE_CART,
  cartCommitAction,
  cartCounts,
  cartErrorKey,
  cartItemRemovePath,
  cartItems,
  cartItemsRemovable,
  cartLockedForStaff,
  cartPendingAmount,
  cartPhase,
  cartProductState,
  hasCart,
  pendingCartCancelErrorKey,
  separateStandaloneCart,
  standaloneCartItems,
  standaloneCommitAction,
  standaloneSecondsLeft,
} from '@/lib/memberCart';
import { RETRY_PAYMENT_PARAM, wantsPaymentRetry } from '@/lib/paymentReturn';
import {
  MemberProfessionalServices,
  type MemberServiceBalanceItem,
} from '@/components/MemberProfessionalServices';
import { MemberDialog } from '@/components/MemberDialog';
import { MemberCollapsibleCard } from '@/components/MemberCollapsibleCard';
import { CartSummary } from '@/components/CartSummary';
import { MemberCart } from '@/components/MemberCart';
import { ImagePreviewButton } from '@/components/ImagePreview';
import { MemberPlanCard, MemberPlanCatalogue, type MemberPlanCardItem } from '@/components/MemberPlanCatalogue';
import type { PlanOverviewView } from '@/components/MemberPlanOverview';
import {
  type MemberPendingPlan,
  type MemberPlanOffer,
  assignErrorKey,
  beneficiaryCountErrorKey,
  declinedBenefitsPayload,
  defaultBeneficiaryIds,
  offersBeneficiaryChoice,
  toggleBeneficiary,
  type FamilyMemberOption,
  planBenefitKey,
  planFinalPriceText,
  planFrequencyKey,
  planPriceText,
  planPromotionBenefitNote,
  planPromotionDurationNote,
} from '@/lib/memberPlanCatalogue';
import { PastMembershipPlansCard } from '@/components/PastMembershipPlansCard';
import {
  type MemberPastPlan,
  type PastPlanText,
  pastPlanLineGroup,
  pastPlanLineMeta,
  pastPlanName,
  pastPlanStatusKey,
  pastPromotionBenefitText,
  pastPromotionName,
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
  type OwnPurchase,
  ownPurchasePayPath,
  ownPurchaseShowsPay,
  ownPurchaseStateKey,
  ownPurchaseStatusWord,
  type ProductAssignee,
  assigneeOptions,
  assigneePayload,
  ownPurchaseAssigneeName,
  showsAssigneeChoice,
  type MemberSetRow,
  type MemberSetView,
  currentSetId,
  setPlans,
  setProductLines,
  setLineStatusKey,
  type MemberSetPlan,
  pendingPaymentPlanSnapshotId,
  draftErrorKey,
  draftProductState,
  draftPlanState,
  type MemberSetReview,
  reviewSections,
  reviewLineDiscount,
  reviewFrequencyKey,
  setCommitAction,
  setCommitErrorKey,
  checkoutRequestBody,
  planFeeScopeNote,
} from '@/lib/memberProducts';
import {
  type BillingEventForecast,
  type MemberBillingEvent,
  EMPTY_FORECAST,
  billingEventAmount,
  forecastPaymentAnchorId,
  planNextPayment,
  productNextPayment,
  formatPaymentAmount,
  formatPaymentDate,
  lineKindKey,
  billingEventHasDetails,
  billingEventLineAmount,
  billingEventLineRegularAmount,
  paymentDocumentLabelKey,
  paymentDocumentPath,
  paymentDocumentFileName,
  paymentDocumentKey,
  paymentScheduledDate,
  paymentSections,
  paymentTypeKey,
  refundTypeKey,
  utcToday,
  type MemberPaymentDocument,
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
// #1823 — grouped by what the item is (one-time or recurring), never by its
// old section: a period-benefit line or a recurring frequency is Recurring.
type ItemGroup = 'onetime' | 'recurring';
/** #3293 — one item row of a plan card, active or past, already worded. */
interface PlanLineRow {
  key: string;
  group: ItemGroup;
  name: string;
  meta: string;
  imageUrl: string | null;
  imageThumbnailUrl: string | null;
}
const ITEM_GROUPS: ItemGroup[] = ['onetime', 'recurring'];
const RECURRING_ITEM_FREQUENCIES = ['week', 'four_weeks', 'month', 'year'];
/** #2496 stage 4 — `draftBusy` while a plan is being added to or taken off the Draft. */
const PLAN_BUSY = -2;
function itemGroupOf(b: Benefit): ItemGroup {
  return RECURRING_ITEM_FREQUENCIES.includes(b.billing_frequency ?? '') ? 'recurring' : 'onetime';
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
  /** #2660: the Admin's status for this assignment (`LIFECYCLE_STATUS_SQL`), shown as is. */
  lifecycle_status?: string;
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
  status: 'pending' | 'completed' | 'failed' | 'expired' | 'cancelled';
  billing_interval: number | null;
  billing_unit: 'day' | 'week' | 'month' | 'year' | null;
  created_at: string;
}


function formatInterval(interval: number, unit: string, t: (k: string) => string): string {
  const unitKey = `billing_unit.${unit}_${interval === 1 ? 'one' : 'other'}`;
  return `${interval} ${t(unitKey)}`;
}

export default function MembershipPage() {
  const t = useTranslations();
  const locale = useLocale();
  const gymFmt = useGymFormatSettings();
  const router = useRouter();
  // #2737 — My Products, Add Plan or Add Product: one component, three routes.
  const mode = membershipPageMode(usePathname());
  const { apiFetch, downloadFetch } = useApiClient();
  const { isLinked, loading: appLoading, gymName, isSuperadmin, member: appMember } = useApp();
  const { isImpersonating } = useImpersonation();
  const { flags: featureFlags } = useFeatureFlags();

  const [membership, setMembership] = useState<Membership | null>(null);
  // #1122 §7 — the member's finished plans, which the server splits off the one
  // ordering that decides which assignment the card above is about, so this page
  // never filters a list by status for itself.
  const [pastPlans, setPastPlans] = useState<MemberPastPlan[]>([]);
  // #2125: the member's other live plans, beside the one the page is about.
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
  // #2905 — the Professional Services the catalogue may be narrowed by (the
  // server's list, read from the unfiltered catalogue), and the in-flight
  // re-read when the member picks one.
  const [serviceOptions, setServiceOptions] = useState<ServiceOption[]>([]);
  const [filteringProducts, setFilteringProducts] = useState(false);
  // The notice "products that unlock the class you tried to book" is about a
  // filter a refused booking set (#1189 stage 4), not one the member chose.
  const [filterFromBooking, setFilterFromBooking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [downloadingDocument, setDownloadingDocument] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);

  // #1121 stage 2 — the Product the member is confirming, and that one
  // dialog's own submit state. `null` means no dialog.
  const [purchasing, setPurchasing] = useState<MemberProduct | null>(null);
  const [purchaseSubmitting, setPurchaseSubmitting] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  // #2609 stage 2 — the member's family (themself included; `[]` with no family)
  // and who the Product in the dialog is for. The server judges the choice again.
  const [assignees, setAssignees] = useState<ProductAssignee[]>([]);
  const [selfMemberId, setSelfMemberId] = useState<number | null>(null);
  const [purchaseAssignee, setPurchaseAssignee] = useState<number | null>(null);

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

  // #2496 stage 3 — the member's current version (their Draft, else their
  // Active one) as the server reads it, the Product an Add/Remove is in flight
  // for, and the refusal of the last one (keyed by Product). Every figure and
  // every rule stays the server's; this is which card says what.
  const [setView, setSetView] = useState<MemberCartView | null>(null);
  // #2949 stage 6 — the member's standalone one-time purchases (`GET /me/cart/purchases`),
  // read with the set view; the seconds until the first leaves the cart, taken at that read.
  const [standaloneCart, setStandaloneCart] = useState<MemberStandaloneCart>(EMPTY_STANDALONE_CART);
  const [standaloneSeconds, setStandaloneSeconds] = useState<number | null>(null);
  // #2663 — `My Plans` and `My Products` render only once the one selected version is known.
  const [setViewLoaded, setSetViewLoaded] = useState(false);
  const [draftBusy, setDraftBusy] = useState<number | null>(null);
  const [draftError, setDraftError] = useState<{ productId: number | null; key: string } | null>(null);
  // #2496 stage 4 — a refused plan edit, shown on the plan card it came from.
  const [planDraftError, setPlanDraftError] = useState<{ planId: number; key: string } | null>(null);
  // #2496 stage 5 — the Draft's Summary (the Admin's own review) and its one commit.
  const [review, setReview] = useState<MemberSetReview | null>(null);
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  // #2746 stage 2 — the cart's global Cancel asks first; the item a per-item
  // Cancel is in flight for, and the refusal of the last cart edit.
  const [cartBusy, setCartBusy] = useState<string | null>(null);
  const [cartError, setCartError] = useState<string | null>(null);
  // #2746 stage 3 — the cart awaiting payment is cancelled as a whole (#2747), after a confirmation.
  const [confirmPendingCancel, setConfirmPendingCancel] = useState(false);

  // #1122 §1–§6 — Add Plan. The catalogue is read when the member opens it,
  // the Promotion applied per plan is page state (its snapshot is written by
  // the assignment itself, §5/§6), and the plan awaiting its first payment is
  // what the server reports beside the current one (#1108 stage 2).
  const [ownPurchases, setOwnPurchases] = useState<OwnPurchase[]>([]);
  const [payingPurchase, setPayingPurchase] = useState<number | null>(null);
  const [pendingMembership, setPendingMembership] = useState<MemberPendingPlan | null>(null);
  // #2770: only the Family Owner adds Plans and Products (the API decides; this hides the actions).
  const [canAdd, setCanAdd] = useState(true);
  // #2776 — the Payments tab is the Family Owner's; the API decides.
  const [paymentsVisible, setPaymentsVisible] = useState(true);
  const [planCatalogue, setPlanCatalogue] = useState<MemberPlanOffer[] | null>(null);
  // #3091 — who a plan covers, chosen while contracting (the member's own family, themselves first).
  const [planFamily, setPlanFamily] = useState<FamilyMemberOption[]>([]);
  const [planBeneficiaries, setPlanBeneficiaries] = useState<Record<number, number[]>>({});
  // `null` = not read yet or the read failed: the control stays; `[]` = the gym has
  // nothing to offer, so it is absent rather than leading to an empty list.
  const gymOffersPlans = planCatalogue === null || planCatalogue.length > 0;
  const [catalogueLoading, setCatalogueLoading] = useState(false);
  const [appliedPlanPromotions, setAppliedPlanPromotions] = useState<Record<number, number>>({});
  // #2743 — the plan whose Draft is being created; set while the request runs, so
  // a second click (on any plan) does nothing.
  const [choosingPlanId, setChoosingPlanId] = useState<number | null>(null);
  // #1184 stage 3b: optional Plan benefits the member unticked, per plan.
  const [declinedPlanBenefits, setDeclinedPlanBenefits] = useState<Record<number, string[]>>({});
  // #2495 — the server's re-quote of a plan's overview for the declined selection.
  const [overviewOverrides, setOverviewOverrides] = useState<Record<number, MemberPlanOffer['overview']>>({});
  const [reloadKey, setReloadKey] = useState(0);
  // #1779 — the Professional Services tab. `null` = the read failed.
  const [serviceBalances, setServiceBalances] = useState<MemberServiceBalanceItem[] | null>([]);
  const [tab, setTab] = useState<'products' | 'services' | 'payments'>('products');
  // #3235 — the forecast payment *View payment* opened on the Payments tab (its date).
  const [focusedPayment, setFocusedPayment] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== 'payments' || !focusedPayment) return;
    const el = document.getElementById(forecastPaymentAnchorId(focusedPayment));
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [tab, focusedPayment]);

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
    setFilterFromBooking(filter.length > 0);
    (async () => {
      try {
        const [mship, ledger, pkgs, promos, prs, projection, catalogue, plansRes, serviceRes, ownRes, assigneeRes] = await Promise.all([
          apiFetch<{ membership: Membership | null; other_memberships?: MemberPastPlan[]; past_memberships?: MemberPastPlan[]; pending_membership?: MemberPendingPlan | null; can_add_plans_and_products?: boolean; can_view_payments?: boolean }>('/me/membership'),
          // #2776: a family member who is not the owner is refused (403); the tab is then hidden.
          apiFetch<{ items: BillingEvent[] }>('/me/billing-events?limit=50').catch(() => ({ items: [] as BillingEvent[] })),
          apiFetch<UserPackage[]>('/me/class-packages').catch(() => []),
          apiFetch<Promotion[]>('/me/promotions').catch(() => []),
          apiFetch<PaymentRequest[]>('/me/payment-requests').catch(() => []),
          apiFetch<BillingEventForecast>('/me/billing-event-forecast').catch(() => EMPTY_FORECAST),
          apiFetch<{ items: MemberProduct[]; professional_services?: ServiceOption[] }>(productsQuery(filter)).catch(() => null),
          // Read with the page, not on opening the catalogue: a gym with no plans
          // to offer must not show a control that opens onto "no plans". A failed
          // read leaves `null`, which keeps the control (and the read on open).
          apiFetch<{ plans: MemberPlanOffer[]; family_members?: FamilyMemberOption[] }>('/me/membership-plans').catch(() => null),
          apiFetch<{ items: MemberServiceBalanceItem[] }>('/me/professional-services').catch(() => null),
          apiFetch<{ items: OwnPurchase[] }>('/me/purchases').catch(() => null),
          // #2609: a failed read is "no family" — the Buy dialog then asks nothing.
          apiFetch<{ member_id: number; members: ProductAssignee[] }>('/me/products/assignees').catch(() => null),
        ]);
        if (cancelled) return;
        setMembership(mship.membership);
        setPastPlans(mship.past_memberships ?? []);
        setPendingMembership(mship.pending_membership ?? null);
        setCanAdd(canAddPlansAndProducts(mship.can_add_plans_and_products));
        const showPayments = canViewPayments(mship.can_view_payments);
        setPaymentsVisible(showPayments);
        if (!showPayments) setTab((current) => (current === 'payments' ? 'products' : current));
        setEvents(ledger.items);
        setPackages(pkgs);
        setPromotions(promos);
        setPaymentRequests(prs);
        setForecast(projection);
        setProducts(catalogue?.items ?? null);
        setServiceOptions(catalogue?.professional_services ?? []);
        setPlanCatalogue(plansRes?.plans ?? null);
        setPlanFamily(plansRes?.family_members ?? []);
        setServiceBalances(serviceRes?.items ?? null);
        setOwnPurchases(ownRes?.items ?? []);
        setAssignees(assigneeRes?.members ?? []);
        setSelfMemberId(assigneeRes?.member_id ?? null);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? t('common.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appLoading, isLinked, locale, isSuperadmin, isImpersonating, featureFlags, reloadKey]);

  // #2496 stage 3 — read with the page and after every Draft edit.
  async function loadSetView() {
    // #2949 stage 6: a failed read is an empty standalone cart, never a reason to hide the set's.
    const standalone = apiFetch<MemberStandaloneCart>('/me/cart/purchases')
      .then((c) => ({
        purchases: c?.purchases ?? [], total: c?.total == null ? null : Number(c.total), currency: c?.currency ?? null,
        awaiting_staff_setup: c?.awaiting_staff_setup === true,
      }))
      .catch(() => EMPTY_STANDALONE_CART)
      .then((c) => { setStandaloneCart(c); setStandaloneSeconds(standaloneSecondsLeft(c, Date.now())); });
    try {
      const rows = await apiFetch<MemberSetRow[]>('/me/product-sets');
      const id = currentSetId(rows);
      let view = id == null ? null : await apiFetch<MemberCartView>(`/me/product-sets/${id}`);
      // #2477 stage 3 — a Draft past its two hours is no longer the member's to
      // edit, even before the discard pass removes it: read their Active
      // version instead and say what happened.
      if (isExpiredDraft(view)) {
        const activeId = currentSetId(rows.filter((r) => r.status !== 'in_cart'));
        view = activeId == null ? null : await apiFetch<MemberCartView>(`/me/product-sets/${activeId}`);
        setDraftError({ productId: null, key: 'membership.draft_error_expired' });
      }
      setSetView(view);
    } catch {
      // No version to read: every recurring card offers Add, and the server
      // still judges the add itself.
      setSetView(null);
    } finally {
      await standalone;
      setSetViewLoaded(true);
    }
  }

  useEffect(() => {
    if (appLoading || !isLinked) return;
    loadSetView();
  }, [appLoading, isLinked, reloadKey]);

  // #2477 stage 3 — the Draft's live countdown, from the server's seconds; at
  // zero the page re-reads, so an expired Draft stops being offered for editing.
  // #2949 stage 6: with standalone purchases in the cart, the first of them to leave it counts too.
  const setSeconds = setView?.status === 'in_cart' ? setView.expires_in_seconds ?? null : null;
  const draftSecondsLeft = useDraftCountdown(
    setSeconds == null ? standaloneSeconds : standaloneSeconds == null ? setSeconds : Math.min(setSeconds, standaloneSeconds),
    loadSetView,
  );
  const viewerId = appMember?.id ?? null;

  /** Adds a recurring Product to the member's Draft, creating it if there is none. */
  async function addToDraft(product: MemberProduct) {
    setDraftBusy(product.id);
    setDraftError(null);
    try {
      const draft = await apiFetch<{ id: number }>('/me/product-sets/draft', { method: 'POST' });
      // The Product alone: the price, the start date and the Promotions are the
      // Draft writer's, exactly as in the Admin.
      await apiFetch(`/me/product-sets/${draft.id}/services`, {
        method: 'POST', body: JSON.stringify({ product_id: product.id }),
      });
    } catch (err: any) {
      setDraftError({ productId: product.id, key: draftErrorKey(err?.message) });
    } finally {
      await loadSetView();
      setDraftBusy(null);
    }
  }

  async function removeFromDraft(product: MemberProduct, lineId: number) {
    if (!setView) return;
    setDraftBusy(product.id);
    setDraftError(null);
    try {
      await apiFetch(`/me/product-sets/${setView.id}/services/${lineId}`, { method: 'DELETE' });
    } catch (err: any) {
      setDraftError({ productId: product.id, key: draftErrorKey(err?.message) });
    } finally {
      await loadSetView();
      setDraftBusy(null);
    }
  }

  /**
   * #2496 stage 4 — Add Plan on the shared Draft: the plan, its applied
   * Promotion and its declined optional Products go to the very Draft the
   * Products are on (created if there is none), never a second one. Every rule
   * is the server's (`POST /me/product-sets/:id/plans`).
   */
  async function addPlanToDraft(plan: MemberPlanOffer) {
    setDraftBusy(PLAN_BUSY);
    setPlanDraftError(null);
    try {
      const draft = await apiFetch<{ id: number }>('/me/product-sets/draft', { method: 'POST' });
      const applied = appliedPlanPromotions[plan.id] ?? null;
      await apiFetch(`/me/product-sets/${draft.id}/plans`, {
        method: 'POST',
        body: JSON.stringify({
          membership_plan_id: plan.id,
          promotion_ids: applied ? [applied] : [],
          declined_benefits: declinedBenefitsPayload(plan.benefits, new Set(declinedPlanBenefits[plan.id] ?? [])),
          ...beneficiaryBody(plan),
        }),
      });
    } catch (err: any) {
      setPlanDraftError({ planId: plan.id, key: draftErrorKey(err?.message) });
    } finally {
      await loadSetView();
      setDraftBusy(null);
    }
  }

  async function removePlanFromDraft(planId: number, planSnapshotId: number) {
    if (!setView) return;
    setDraftBusy(PLAN_BUSY);
    setPlanDraftError(null);
    try {
      await apiFetch(`/me/product-sets/${setView.id}/plans/${planSnapshotId}`, { method: 'DELETE' });
    } catch (err: any) {
      setPlanDraftError({ planId, key: draftErrorKey(err?.message) });
    } finally {
      await loadSetView();
      setDraftBusy(null);
    }
  }

  // #2496 stage 5 — the Summary is re-read with the version, so every Draft
  // edit is reflected at once; nothing is computed in the page.
  useEffect(() => {
    if (!setView || setView.status !== 'in_cart') { setReview(null); return; }
    let cancelled = false;
    apiFetch<MemberSetReview>(`/me/product-sets/${setView.id}/review`)
      .then((r) => { if (!cancelled) setReview(r); })
      .catch(() => { if (!cancelled) setReview(null); });
    return () => { cancelled = true; };
  }, [setView]);

  /**
   * #2496 stage 5 — one Save & Pay for the whole Draft: the Admin's own commit,
   * behind the member's routes. Something owed today goes to the hosted page;
   * nothing owed activates. The amount is the server's; the body names nothing.
   */
  async function commitSet() {
    const action = cartCommitAction(setView, review, viewerId, standaloneCart);
    if (action === 'cart_checkout') return checkoutStandalone();
    if (!review || !action || commitBusy) return;
    setCommitBusy(true);
    setCommitError(null);
    try {
      if (action === 'save_and_pay') {
        const out = await apiFetch<{ checkout_url: string }>(`/me/product-sets/${review.product_set_id}/save-and-pay`, {
          method: 'POST', body: checkoutRequestBody(review.amount_due),
        });
        window.location.href = out.checkout_url;
        return; // stays busy while the browser leaves for the payment page
      }
      await apiFetch(`/me/product-sets/${review.product_set_id}/activate`, { method: 'POST' });
      setReloadKey((k) => k + 1);
    } catch (err: any) {
      setCommitError(setCommitErrorKey(err?.message));
      await loadSetView();
    }
    setCommitBusy(false);
  }

  /**
   * #2949 stage 6 — the standalone purchases' own checkout (no Draft to pay them):
   * one payment for all of them, at the server's total, on the hosted page.
   */
  async function checkoutStandalone() {
    if (commitBusy) return;
    setCommitBusy(true);
    setCommitError(null);
    try {
      const out = await apiFetch<{ checkoutUrl: string }>('/me/cart/checkout', { method: 'POST', body: checkoutRequestBody(standaloneCart.total) });
      window.location.href = out.checkoutUrl;
      return; // stays busy while the browser leaves for the payment page
    } catch (err: any) {
      setCommitError(cartErrorKey(err?.message));
      await loadSetView();
    }
    setCommitBusy(false);
  }

  /**
   * #2746 stage 2 — one item's own Cancel: only that plan, recurring line or
   * one-time Product leaves the Draft, through the route that added it. The
   * server keeps every other item and re-prices the cart.
   */
  async function removeCartItem(item: CartItem) {
    if (cartBusy !== null) return;
    // #2949 stage 6: a standalone purchase leaves through its own route; a set item only from a Draft.
    const standalone = item.kind === 'purchase' && item.standalone;
    if (!standalone && (!setView || setView.status !== 'in_cart')) return;
    const path = cartItemRemovePath(item, setView?.id ?? null);
    if (!path) return;
    setCartBusy(item.key);
    setCartError(null);
    try {
      await apiFetch(path, { method: 'DELETE' });
    } catch (err: any) {
      setCartError(cartErrorKey(err?.message));
    } finally {
      await loadSetView();
      setCartBusy(null);
    }
  }

  /**
   * #2746 stage 3 — the cart awaiting payment is cancelled as one purchase,
   * and (#2747 stage 2) so is a plan awaiting payment from its own card: every
   * Cancel of a version awaiting payment asks first and reaches this one route,
   * through the member route (#3309): the payment attempt is cancelled and the version goes back to the cart with its items,
   * and the server refuses while a payment settled or is still in flight.
   */
  async function cancelPendingCart() {
    if (!setView || setView.status !== 'pending_payment' || commitBusy) return;
    setCommitBusy(true);
    setCommitError(null);
    try {
      await apiFetch(`/me/product-sets/${setView.id}/cancel`, { method: 'POST' });
      setReloadKey((k) => k + 1);
    } catch (err: any) {
      setCommitError(pendingCartCancelErrorKey(err?.message));
      await loadSetView();
    } finally {
      setCommitBusy(false);
      setConfirmPendingCancel(false);
    }
  }

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
  // #2746 stage 3: a cart awaiting payment is paid as one, for its initial event's amount.
  const pendingCartAmount = cartPhase(setView, appMember?.id ?? null) === 'pending_payment' ? cartPendingAmount(setView) : null;
  const consentAmount = pendingCartAmount != null
    ? pendingCartAmount.toFixed(2)
    : pendingRequest
    ? parseFloat(pendingRequest.amount).toFixed(2)
    : pendingMembership?.membership_fee != null ? pendingMembership.membership_fee.toFixed(2)
    : membership?.membership_fee != null ? membership.membership_fee.toFixed(2) : '';
  const consentCurrency = pendingRequest?.currency ?? 'EUR';
  // The plan awaiting payment is what the POST charges while one exists, so its
  // cadence is what the member is told — never the active plan's (#1081).
  const consentInterval = pendingRequest
    ? (pendingRequest.billing_interval ?? pendingMembership?.billing_interval ?? membership?.billing_interval ?? null)
    : (pendingMembership ? pendingMembership.billing_interval ?? null : membership?.billing_interval ?? null);
  const consentUnit = pendingRequest
    ? (pendingRequest.billing_unit ?? pendingMembership?.billing_unit ?? membership?.billing_unit ?? null)
    : (pendingMembership ? pendingMembership.billing_unit ?? null : membership?.billing_unit ?? null);
  // No cadence means a single payment: say so, never "every —".
  const consentRecurring = consentInterval != null && consentUnit != null;

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

  // #2936/#3242 — a stored document of one of the member's payments, saved as a
  // file. It goes through `downloadFetch` (the tenant headers the API needs) and
  // an anchor click rather than `window.open` after an await, which a browser
  // treats as an unrequested popup and blocks. Nothing is issued: the route
  // serves the stored document or answers 404.
  async function downloadDocument(doc: MemberPaymentDocument) {
    const key = paymentDocumentKey(doc);
    setDownloadingDocument(key);
    setDocumentError(null);
    try {
      const blob = await downloadFetch(paymentDocumentPath(doc));
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = paymentDocumentFileName(doc);
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setDocumentError(t('payments.documents_download_failed'));
    } finally {
      setDownloadingDocument(null);
    }
  }

  function openConsent() {
    setConsentChecked(false);
    setSubmitError(null);
    setConsentOpen(true);
  }

  // "Try again" on the payment error page lands here with `?pay=1`: reopen the
  // payment dialog for whatever is payable, so the member enters a card again
  // on a new checkout (a checkout link is single use). The flag is removed from
  // the address bar so a reload does not reopen it.
  useEffect(() => {
    if (loading || !wantsPaymentRetry(window.location.search)) return;
    const url = new URL(window.location.href);
    url.searchParams.delete(RETRY_PAYMENT_PARAM);
    window.history.replaceState(null, '', url.toString());
    if (pendingMembership || pendingRequest || showStartPayment) openConsent();
  }, [loading]);

  /* ── #1123 / #3297 Payments ─────────────────────────────────────────────── */
  //
  // Which payments belong to which section is `lib/memberPayments.ts`' decision
  // (`paymentSections()`); the page's only job is to resolve the labels and hand
  // the component strings it can render. No amount is computed here — every
  // figure below is the server's, formatted.

  const money = (amount: number | null) => formatPaymentAmount(amount, forecast.currency, gymFmt);

  // #3297 — the three sections, by each payment's scheduled execution date.
  const sections = paymentSections(events, utcToday());

  /* ── #1862 My purchased Products ────────────────────────────────────────── */

  /** Pay on a purchase awaiting payment: the same hosted page the purchase used. */
  async function payPurchase(purchase: OwnPurchase) {
    setPayingPurchase(purchase.id);
    try {
      const result = await apiFetch<{ checkoutUrl: string }>(ownPurchasePayPath(purchase), { method: 'POST' });
      window.location.href = result.checkoutUrl;
    } catch (err: any) {
      setError(err?.message ?? t('common.error'));
      setPayingPurchase(null);
    }
  }

  /* ── #2663 My Plans + My Products — one Product Set, read once ─────────── */
  //
  // Both sections read `setView`, the one version `currentSetId()` selects (the
  // member's Draft, else the version awaiting payment, else the Active one), so
  // the plans and the Products on screen always belong to the same version.
  // Every figure is that version's own snapshot, as the server reports it.

  /** #3235 — open the Payments tab on the payment a plan or Product card is part of. */
  function openPayment(date: string) {
    setFocusedPayment(date);
    setTab('payments');
  }

  function renderMyPlans() {
    if (!setViewLoaded) return null;
    const plans = setPlans(setView);
    // #2746 stage 3 (§7): while the cart carries the pending payment, no plan card repeats it.
    const payablePlanId = cartPhase(setView, appMember?.id ?? null) === 'pending_payment'
      ? null : pendingPaymentPlanSnapshotId(setView, appMember?.id ?? null);
    return (
      <section style={styles.section}>
        <h2 style={styles.h2}>{t('membership.my_plans_heading')}</h2>
        {plans.length === 0 ? (
          <div style={styles.emptyCard}>
            <p style={styles.hint}>{t('membership.my_plans_empty')}</p>
          </div>
        ) : (
          <ul style={styles.planList}>
            {plans.map((plan) => <MemberPlanCard key={plan.plan_snapshot_id} item={myPlanCardItem(plan, plan.plan_snapshot_id === payablePlanId)} />)}
          </ul>
        )}
      </section>
    );
  }

  /**
   * #2744 — a plan the member holds, drawn with the Add Plan catalogue's own
   * card (one plan card implementation): picture, name, description, included
   * and optional Products, price and cadence, and the existing details once
   * expanded. A plan awaiting its first payment says so under its name with its
   * own *Pay now* (the existing consent + checkout) and *Cancel* (the existing
   * cancellation of the version awaiting payment).
   */
  function myPlanCardItem(plan: MemberSetPlan, payable: boolean): MemberPlanCardItem {
    const status = plan.status ?? setView?.status ?? 'active';
    const benefits = (plan.benefits ?? []) as (Benefit & { final_price?: number | null; mandatory?: boolean; assigned_member_id?: number | null; member_name?: string | null; image_url?: string | null; image_thumbnail_url?: string | null })[];
    const frequencyKey = planFrequencyKey({ billing_interval: plan.billing_interval ?? null, billing_unit: plan.billing_unit ?? null });
    const feeScopeNote = planFeeScopeNote(plan);
    // #3235 — the collapsed card names who the plan covers (*Beneficiaries*), not what it includes.
    const beneficiaryNames = (plan.beneficiaries ?? []).map((b) => b.name ?? '—');
    // #3235 — the amount is the next scheduled payment the plan is part of, never a line's price.
    const next = paymentsVisible ? planNextPayment(forecast, plan.user_membership_id) : null;
    const pendingAmount = payable && pendingMembership?.membership_fee != null
      ? formatPaymentAmount(pendingMembership.membership_fee, 'EUR', gymFmt) : null;
    return {
      key: String(plan.plan_snapshot_id),
      name: plan.plan_name ?? '—',
      description: [plan.plan_description, plan.entitlement_only ? t('membership.plan_entitlement_only') : null].filter(Boolean).join(' · ') || null,
      price: next ? money(next.total)
        : plan.membership_fee != null ? formatPaymentAmount(plan.membership_fee, 'EUR', gymFmt) : null,
      frequency: next ? t('membership.next_payment_on', { date: formatPaymentDate(next.date, gymFmt) }) : [
        frequencyKey
          ? t(frequencyKey as any)
          : (plan.billing_interval != null && plan.billing_unit ? formatInterval(plan.billing_interval, plan.billing_unit, t) : null),
        // #2834 stage 2 — per member (× how many) or per family; the price is one fee.
        feeScopeNote ? t(`membership.${feeScopeNote.key}` as any, feeScopeNote.values) : null,
      ].filter(Boolean).join(' · ') || null,
      imageUrl: plan.plan_image_thumbnail_url ?? null,
      imageFullUrl: plan.plan_image_url ?? null,
      includedLabel: t('membership.plan_beneficiaries'),
      included: beneficiaryNames.length > 0 ? beneficiaryNames.join(', ') : null,
      // #2798 — always the start date; the end date, or *Open-ended* when the plan has none.
      period: t('membership.plan_period', {
        start: plan.starts_at ? formatGymDateOnly(plan.starts_at, gymFmt) : '—',
        end: plan.ends_at ? formatGymDateOnly(plan.ends_at, gymFmt) : t('membership.plan_period_open_ended'),
      }),
      status: <StatusPill status={status} label={t(`membership.status.${status}` as any)} />,
      notice: payable ? (
        <div style={styles.planPendingPayment} data-plan-pending-payment>
          <span style={styles.planPendingText}>
            {t('membership.plan_pending_payment_amount', { amount: pendingAmount ?? '—' })}
          </span>
          <span style={styles.planPendingActions}>
            <button type="button" style={styles.draftSecondaryBtn} disabled={commitBusy || submitting} onClick={() => setConfirmPendingCancel(true)}>
              {t('membership.plan_pending_cancel')}
            </button>
            <button type="button" style={primaryButtonStyle} disabled={commitBusy || submitting} onClick={openConsent}>
              {t('membership.pending_plan_pay')}
            </button>
          </span>
          {commitError && <span role="alert" style={{ ...styles.draftError, flexBasis: '100%' }}>{t(commitError as any)}</span>}
        </div>
      ) : null,
      details: (
        <>
          {/* #2798 — the dates are the collapsed header's Plan Period, not repeated here. */}
          {next && (
            <div style={styles.viewPaymentRow}>
              <button type="button" style={secondaryButtonStyle} data-view-payment onClick={() => openPayment(next.date)}>
                {t('membership.view_payment')}
              </button>
            </div>
          )}
          {plan.discount_reason && (
            <dl style={styles.dl}>
              <div style={styles.row}>
                <dt style={styles.dt}>{t('membership.price')}</dt>
                <dd style={styles.dd}><span style={styles.discount}>{plan.discount_reason}</span></dd>
              </div>
            </dl>
          )}
          {benefits.length > 0 && renderPlanLineGroups(benefits.map((b) => {
            // #3235 — quantity, frequency and beneficiary; no price, no Mandatory chip.
            const beneficiary = b.member_name ?? (beneficiaryNames.length > 0 ? beneficiaryNames.join(', ') : null);
            return {
              key: `${b.category}-${b.product_id}-${b.assigned_member_id ?? ''}`,
              group: itemGroupOf(b),
              name: b.name,
              meta: [
                t('membership.plan_line_quantity', { quantity: b.quantity }),
                b.billing_frequency ? t(`membership.frequency.${b.billing_frequency}` as any) : null,
                beneficiary ? t('membership.plan_line_beneficiary', { name: beneficiary }) : null,
              ].filter(Boolean).join(' · '),
              imageUrl: b.image_url ?? null,
              imageThumbnailUrl: b.image_thumbnail_url ?? null,
            };
          }))}
        </>
      ),
    };
  }

  /**
   * #2892 — a plan's items, one plain list per group (one-time, recurring): no
   * framed card per item and no section box, smaller detail text, the
   * Product's picture beside it when it has one. #3293 — shared by My Plans
   * and Past Membership Plans, so a past plan's items read as an active one's.
   */
  function renderPlanLineGroups(rows: PlanLineRow[]) {
    return (
      <div style={styles.planLines} data-plan-lines>
        {ITEM_GROUPS.map((group) => {
          const groupRows = rows.filter((r) => r.group === group);
          if (groupRows.length === 0) return null;
          return (
            <div key={group} style={styles.planLineGroup}>
              <h3 style={styles.planLineGroupLabel}>{t(`membership.item_group.${group}`)}</h3>
              <ul style={styles.benefitList}>
                {groupRows.map((r) => (
                  <li key={r.key} style={styles.planLine}>
                    {/* #2798 — the Product's picture on the far left; none means no placeholder. */}
                    {r.imageThumbnailUrl && (
                      <ImagePreviewButton src={r.imageUrl ?? r.imageThumbnailUrl} alt={r.name} title={r.name} style={styles.benefitThumb}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={r.imageThumbnailUrl} alt={r.name} style={styles.benefitThumbImg} />
                      </ImagePreviewButton>
                    )}
                    <span style={styles.planLineText}>
                      <span style={styles.planLineName}>{r.name}</span>
                      <span style={styles.planLineMeta}>{r.meta}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    );
  }

  function renderMyProducts() {
    if (!setViewLoaded) return null;
    const items: MemberProductCardItem[] = setProductLines(setView).map((line) => {
      const quantity = line.quantity ?? 1;
      const currency = line.currency ?? 'EUR';
      const regular = line.regular_amount ?? null;
      const final = line.final_amount ?? null;
      const assignee = line.assigned_member_id != null && selfMemberId != null && line.assigned_member_id !== selfMemberId
        ? assignees.find((a) => a.member_id === line.assigned_member_id)?.name ?? null : null;
      // #2781 — each Product carries its own status chip; the Product Set's is never shown.
      const lineStatusKey = setLineStatusKey(line);
      // #3235 — the next scheduled payment the line is part of, its amount on the card.
      const next = paymentsVisible ? productNextPayment(forecast, line.product_id) : null;
      return {
        key: `set-line-${line.id}`,
        name: line.product_name ?? '—',
        description: line.description ?? null,
        imageUrl: line.image_thumbnail_url ?? null,
        imageFullUrl: line.image_url ?? null,
        price: next ? money(next.total) : final != null ? formatPaymentAmount(final, currency, gymFmt) : null,
        regularPrice: !next && regular != null && final != null && regular !== final ? formatPaymentAmount(regular, currency, gymFmt) : null,
        frequency: next ? t('membership.next_payment_on', { date: formatPaymentDate(next.date, gymFmt) }) : line.billing_frequency && RECURRING_ITEM_FREQUENCIES.includes(line.billing_frequency)
          ? t(`membership.frequency.${line.billing_frequency}` as any) : null,
        meta: [
          quantity > 1 ? `× ${quantity}` : null,
          assignee ? t('membership.product_assignee_line', { name: assignee }) : null,
          line.status === 'cancels_on_end_date' && line.ends_at
            ? t('membership.product_end_date', { date: formatGymDateOnly(line.ends_at, gymFmt) }) : null,
        ].filter(Boolean).join(' · ') || null,
        action: (lineStatusKey && line.status) || next ? (
          <>
            {lineStatusKey && line.status ? <StatusPill status={line.status} label={t(lineStatusKey as any)} /> : null}
            {next && (
              <button type="button" style={{ ...secondaryButtonStyle, marginLeft: 'auto' }} data-view-payment onClick={() => openPayment(next.date)}>
                {t('membership.view_payment')}
              </button>
            )}
          </>
        ) : undefined,
      };
    });
    return (
      <MemberProductsSection
        title={t('membership.set_products_heading')}
        emptyLabel={t('membership.set_products_empty')}
        items={items}
      />
    );
  }

  function renderOwnPurchases() {
    if (ownPurchases.length === 0) return null;
    const items: MemberProductCardItem[] = ownPurchases.map((p) => ({
      key: `own-${p.id}`,
      name: p.product_name,
      price: formatPaymentAmount(p.amount, p.currency, gymFmt),
      meta: [
        // #2609: who it is for, only where the member has a family to tell apart.
        ownPurchaseAssigneeName(p, assignees) ? t('membership.product_assignee_line', { name: ownPurchaseAssigneeName(p, assignees)! }) : null,
        p.end_date ? t('membership.product_end_date', { date: formatGymDateOnly(p.end_date, gymFmt) }) : null,
      ].filter(Boolean).join(' · ') || null,
      action: (
        <>
          <StatusPill status={ownPurchaseStatusWord(p.own_state)} label={t(ownPurchaseStateKey(p.own_state) as any)} />
          {ownPurchaseShowsPay(p) && (
            <button
              type="button"
              style={styles.buyBtn}
              disabled={payingPurchase === p.id}
              onClick={() => payPurchase(p)}
            >
              {t('membership.product_pay')}
            </button>
          )}
        </>
      ),
    }));
    return (
      <MemberProductsSection
        title={t('membership.own_products_heading')}
        emptyLabel=""
        items={items}
      />
    );
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
  /**
   * #2905 — narrows the catalogue to one Professional Service, or clears it.
   * The server filters (`?professional_service_ids=`, the same read a refused
   * booking links to), and the address bar follows so a reload keeps it.
   */
  async function applyServiceFilter(ids: number[]) {
    setServiceFilter(ids);
    setFilterFromBooking(false);
    window.history.replaceState(null, '', `/${locale}${productsPathForServices(ids)}`);
    setFilteringProducts(true);
    try {
      const res = await apiFetch<{ items: MemberProduct[] }>(productsQuery(ids));
      setProducts(res.items);
    } catch {
      // Keep the list on screen; the select still says what was asked for.
    } finally {
      setFilteringProducts(false);
    }
  }

  function renderServiceFilter() {
    if (mode !== 'add_product' || serviceOptions.length === 0) return null;
    return (
      <label style={styles.assigneeField}>
        <span style={styles.assigneeLabel}>{t('membership.products_service_filter_label')}</span>
        <select
          style={inputStyle}
          value={serviceFilterSelectValue(serviceFilter)}
          disabled={filteringProducts}
          onChange={(e) => applyServiceFilter(e.target.value ? [Number(e.target.value)] : [])}
        >
          <option value="">{t('membership.products_service_filter_all')}</option>
          {serviceFilter.length > 1 && (
            <option value="multiple" disabled>{t('membership.products_service_filter_several')}</option>
          )}
          {serviceOptions.map((s) => (
            <option key={s.id} value={String(s.id)}>{s.name}</option>
          ))}
        </select>
      </label>
    );
  }

  function renderProducts() {
    if (products === null) return null;
    return (
      <>
      {renderServiceFilter()}
      {filterFromBooking && serviceFilter.length > 0 && (
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>
          {t('membership.products_filtered_notice')}{' '}
          <a
            href={`/${locale}${ADD_PRODUCT_PATH}`}
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
        roundImages
      />
      {renderDraftSelection()}
      </>
    );
  }

  /**
   * #2496 stage 5 — §8/§9: what the Draft contracts and cancels, the itemised
   * Initial Payment and the one Save & Pay, all off the server's review (the
   * Admin's *Review your changes*). A version awaiting payment says so and
   * offers to cancel it. Nothing here prices anything.
   */
  function renderSetSummary() {
    // #2744 — a version awaiting payment is paid and cancelled from its plan
    // card; this notice is left only for a version that has no billed plan.
    if (setView?.status === 'pending_payment' && appMember != null && setView.owner_member_id === appMember.id
      && pendingPaymentPlanSnapshotId(setView, appMember.id) == null && cartPhase(setView, appMember.id) == null) {
      return (
        <section style={styles.section}>
          <div style={{ ...noticeStyle('info'), display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: '1 1 200px', fontSize: 13.5 }}>{t('membership.summary_pending')}</span>
            <button type="button" style={styles.draftSecondaryBtn} disabled={commitBusy} onClick={() => setConfirmPendingCancel(true)}>
              {t('membership.summary_cancel_pending')}
            </button>
            {commitError && <span role="alert" style={styles.draftError}>{t(commitError as any)}</span>}
          </div>
        </section>
      );
    }
    if (!review || setView?.status !== 'in_cart') return null;
    const { contracted, cancelled } = reviewSections(review);
    if (contracted.length + cancelled.length === 0 && !commitError) return null;
    const action = setCommitAction(review);
    const reviewError = review.error ? setCommitErrorKey(review.error) : null;
    // #2894 — the Summary sits near the top of the page (right under the cart)
    // as a collapsible card, closed by default with the total beside its title.
    // Opening it is presentation only: the review was read with the version, so
    // the draft and its selections are untouched. Its body is one linear list
    // with small labels rather than a card per line. The error and the commit
    // button stay outside the card, so a closed Summary never hides either.
    return (
      <div data-set-summary>
        {/* #2973 stage 4: with a cart card the Summary lives inside it. */}
        {!hasCart(setView, viewerId, standaloneCart) && <CartSummary review={review} />}
        {(reviewError || commitError) && (
          <p role="alert" style={{ ...styles.draftError, margin: '8px 0 0' }}>{t((commitError ?? reviewError) as any)}</p>
        )}
        {/* #2746 stage 2 — the cart card above carries the one Pay; the
            button stays here only for a Draft that changes something without
            adding an item (it only cancels one). */}
        {action && !hasCart(setView, viewerId, standaloneCart) && (
          <button type="button" style={{ ...styles.buyBtn, width: '100%', marginTop: 10 }} disabled={commitBusy} onClick={commitSet}>
            {t(action === 'save_and_pay' ? 'membership.summary_save_and_pay' : 'membership.summary_confirm')}
          </button>
        )}
      </div>
    );
  }

  /**
   * #2496 stage 3 — what the member has added to their Draft so far and how
   * long it is kept, with a way to discard it. The count and the countdown are
   * the server's (`GET /me/product-sets/:id`).
   */
  function renderDraftSelection() {
    // #2746 stage 2 — the cart card carries the count, the countdown and the
    // global Cancel; this notice is left for a refusal with no cart to show it.
    const generalError = draftError && draftError.productId === null ? draftError.key : null;
    if (hasCart(setView, viewerId, standaloneCart) || !generalError) return null;
    return (
      <div style={{ ...noticeStyle('info'), marginTop: 12 }}>
        <span role="alert" style={styles.draftError}>{t(generalError as any)}</span>
      </div>
    );
  }

  /**
   * #2973 stage 6 — the cart is the one shared `MemberCart` (Home draws the
   * very same component); the page adds only what is NOT part of the cart: the
   * `+ Add Plan` / `+ Add Product` actions, outside the card. #2973 stage 7
   * (reversing #2895's "disabled, never hidden"): absent while staff are still
   * setting up the Draft — the member can add nothing to a gym-managed cart,
   * and the card itself already says why.
   */
  function renderCart() {
    const phase = cartPhase(setView, viewerId, standaloneCart);
    if (phase == null) return null;
    return (
      <section style={styles.section} data-cart-host>
        <MemberCart refreshKey={setView} onChanged={loadSetView} />
        {phase !== 'awaiting_staff' && renderCartAddButtons()}
      </section>
    );
  }

  // #1779 — tabs over the page; the first is everything the page showed before,
  // less the Payments card, which is its own tab since #2740.
  function renderTabs() {
    const tabStyle = (active: boolean) => ({
      ...(active ? primaryButtonStyle : secondaryButtonStyle),
      padding: '8px 14px',
      fontSize: 14,
    });
    return (
      <div role="tablist" style={{ display: 'flex', gap: 8, margin: '0 0 12px', overflowX: 'auto' }}>
        <button type="button" role="tab" aria-selected={tab === 'products'} style={tabStyle(tab === 'products')} onClick={() => setTab('products')}>
          {t('membership.tab_products')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'services'} style={tabStyle(tab === 'services')} onClick={() => setTab('services')}>
          {t('membership.tab_services')}
        </button>
        {membershipTabs(paymentsVisible).includes('payments') && (
          <button type="button" role="tab" aria-selected={tab === 'payments'} style={tabStyle(tab === 'payments')} onClick={() => setTab('payments')}>
            {t('membership.tab_payments')}
          </button>
        )}
      </div>
    );
  }

  function renderServicesTab() {
    return (
      <MemberProfessionalServices
        items={serviceBalances}
        labels={{
          empty: t('membership.services_empty'),
          error: t('membership.services_error'),
          balance: ({ remaining, available, booked }) => t('membership.services_balance', { total: remaining, available, booked }),
          close: t('membership.services_close'),
          imageAlt: t('membership.services_image_alt'),
        }}
      />
    );
  }

  // #3297 — the documents of one payment, inside that payment. Only what the API
  // listed is drawn (#2936): a missing document is omitted, never a placeholder.
  function renderPaymentDocuments(event: BillingEvent) {
    const docs = event.documents ?? [];
    if (docs.length === 0) return null;
    const byKey = new Map(docs.map((doc) => [paymentDocumentKey(doc), doc]));
    return (
      <>
        <PaymentDocumentList
          rows={docs.map((doc) => {
            const key = paymentDocumentKey(doc);
            const type = t(paymentDocumentLabelKey(doc.kind) as any);
            return {
              key,
              date: formatPaymentDate(doc.issued_at || event.created_at, gymFmt),
              type,
              identifier: doc.number,
              downloadLabel: t('payments.documents_download', { type, number: doc.number }),
              downloading: downloadingDocument === key,
            };
          })}
          onDownload={(key) => { const doc = byKey.get(key); if (doc) downloadDocument(doc); }}
        />
        {documentError && <p role="alert" style={styles.hint}>{documentError}</p>}
      </>
    );
  }

  // #2740 — Payments is its own tab. #3297: Next Payment, Planned Payments and
  // Past Payments, all three from the member's own ledger.
  function renderPaymentsTab() {
    const [nearest, ...unresolved] = sections.next;
    const focusedPlanned = focusedPayment != null
      && sections.planned.some((e) => paymentScheduledDate(e) === focusedPayment);
    return (
      <PaymentsSection>
        <PaymentsSubcard title={t('payments.next_heading')} defaultOpen>
          {nearest ? (
            <>
              <BillingEventCard
                date={formatPaymentDate(paymentScheduledDate(nearest), gymFmt)}
                total={money(billingEventAmount(nearest))}
                totalLabel={t('payments.total')}
                lines={paymentCardLines(nearest)}
                badge={paymentStatusPill(nearest)}
                prominent
              />
              {unresolved.map((event) => renderPaymentRow(event))}
            </>
          ) : (
            <p style={styles.hint}>{t('payments.next_empty')}</p>
          )}
        </PaymentsSubcard>

        <PaymentsSubcard title={t('payments.planned_heading')} forceOpen={focusedPlanned}>
          {sections.planned.length === 0 ? (
            <p style={styles.hint}>{t('payments.planned_empty')}</p>
          ) : (
            sections.planned.map((event, index) => {
              const date = paymentScheduledDate(event);
              const firstOfDate = sections.planned.findIndex((e) => paymentScheduledDate(e) === date) === index;
              return renderPaymentRow(event, {
                anchorId: firstOfDate ? forecastPaymentAnchorId(date) : undefined,
                highlighted: focusedPayment === date,
              });
            })
          )}
        </PaymentsSubcard>

        <PaymentsSubcard title={t('payments.past_heading')}>
          {sections.past.length === 0 ? (
            <p style={styles.hint}>{t('payments.past_empty')}</p>
          ) : (
            // #3299 — each past payment on Next Payment's detailed card.
            sections.past.map((event) => renderPastPaymentCard(event))
          )}
        </PaymentsSubcard>
      </PaymentsSection>
    );
  }

  /* ── #1122 Past Membership Plans ────────────────────────────────────────── */

  function pastText(text: PastPlanText): string {
    return t(text.key as any, text.values as any);
  }

  /**
   * #3293 — a past plan as My Plans' own plan card: name, status pill, agreed
   * fee and cadence, plan period, and once expanded the same one-time /
   * recurring item groups and the Promotions it was agreed with. No picture
   * (none is drawn and no space is kept for one) and no action (§8).
   */
  function pastPlanCardItem(plan: MemberPastPlan): MemberPlanCardItem {
    const details = plan.details ?? null;
    const status = plan.lifecycle_status ?? plan.status;
    const frequencyKey = details
      ? planFrequencyKey({ billing_interval: details.billing_interval, billing_unit: details.billing_unit as any })
      : null;
    const lines = details?.lines ?? [];
    const promotions = details?.promotions ?? [];
    return {
      // #2747 stage 2: a cancelled Product Set's id is not an assignment's.
      key: plan.product_set_id != null ? `ps-${plan.product_set_id}` : String(plan.id),
      name: pastPlanName(plan),
      price: formatPaymentAmount(details?.membership_fee_price ?? null, null, gymFmt),
      frequency: frequencyKey
        ? t(frequencyKey as any)
        : (details?.billing_interval != null && details.billing_unit
          ? formatInterval(details.billing_interval, details.billing_unit, t) : null),
      imageUrl: null,
      period: t('membership.plan_period', {
        start: plan.starts_at ? formatGymDateOnly(plan.starts_at, gymFmt) : '—',
        end: plan.ended_on ? formatGymDateOnly(plan.ended_on, gymFmt) : '—',
      }),
      status: <StatusPill status={status} label={t(pastPlanStatusKey(plan) as any)} />,
      details: lines.length > 0 ? renderPlanLineGroups(lines.map((line, i) => ({
        key: `${line.category}-${i}`,
        group: pastPlanLineGroup(line),
        name: line.product_name,
        meta: pastPlanLineMeta(line).map(pastText).join(' · '),
        imageUrl: null,
        imageThumbnailUrl: null,
      }))) : null,
      promotions: promotions.map((promo) => {
        const revokedOn = promo.revoked_at ? formatPaymentDate(promo.revoked_at, gymFmt) : null;
        const feeFacts = promo.membership_fee_benefits.flatMap((b) => {
          const benefit = pastPromotionBenefitText(b.action, b.value, null, gymFmt);
          if (!benefit) return [];
          const duration = b.duration_months != null
            ? ` (${t('membership.promotion_duration_months', { count: b.duration_months })})` : '';
          return [`${t('membership.past_plan_fee')}: ${pastText(benefit)}${duration}`];
        });
        const productFacts = promo.products.map((g) => {
          const benefit = pastPromotionBenefitText(g.action, g.value, null, gymFmt);
          const quantity = t('membership.past_plan_quantity', { count: g.quantity });
          return `${g.product_name}: ${benefit ? `${quantity} · ${pastText(benefit)}` : quantity}`;
        });
        const revoked = promo.status === 'revoked'
          ? (revokedOn ? `${t('membership.past_plan_promotion_revoked')} · ${revokedOn}` : t('membership.past_plan_promotion_revoked'))
          : null;
        return {
          key: String(promo.id),
          heading: t('membership.promotion_heading'),
          name: pastPromotionName(promo) ?? t('membership.promotion_heading'),
          benefit: [revoked, ...feeFacts, ...productFacts].filter(Boolean).join(' · ') || null,
        };
      }),
    };
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
        items={pastPlans.map(pastPlanCardItem)}
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
        imageUrl: product.image_url ?? null,
        imageFullUrl: product.image_full_url ?? product.image_url ?? null,
        previewTitle: t('membership.preview_product', { name: product.name }),
        imageAlt: product.name,
        // §5: the Final price, which is the applied Promotion's own figure —
        // the server's, never recomputed here (#817).
        price: productFinalPriceText(product, applied, gymFmt),
        regularPrice: showsRegularProductPrice(product, applied)
          ? productPriceText(product, gymFmt)
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
        imageUrl: promotion.image_url ?? null,
        imageFullUrl: promotion.image_full_url ?? promotion.image_url ?? null,
        description: promotion.description ?? null,
        previewTitle: t('membership.preview_promotion', { name: promotion.promotion_name }),
        imageAlt: promotion.promotion_name,
        benefit: promotionNoteText(
          promotionBenefitNote(promotion.action, promotion.value, product.currency, gymFmt),
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
      imageUrl: promotion.image_url ?? null,
      imageFullUrl: promotion.image_full_url ?? promotion.image_url ?? null,
      description: promotion.description ?? null,
      previewTitle: t('membership.preview_promotion', { name: promotion.promotion_name }),
      imageAlt: promotion.promotion_name,
      benefit: promotionNoteText(
        promotionBenefitNote(
          promotion.benefit_action, promotion.benefit_value, product.currency, gymFmt,
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
    // #2496 stage 3 — a recurring Product is added to the member's Draft
    // Product Set, never bought on its own (the server's `addable_to_draft`).
    if (product.addable_to_draft) return draftAction(product);
    // #2746 stage 2 — a one-time Product joins the cart, or is already in it.
    const inCart = cartProductState(product.id, setView, standaloneCart);
    // #3305: a cart staff are still preparing takes nothing from the member — no add, no Cancel.
    const locked = cartLockedForStaff(setView, viewerId, standaloneCart);
    if (inCart.state === 'in_cart' && locked) return <StatusPill status="pending" label={t('membership.cart_in_cart')} />;
    if (locked && showsBuyAction(product)) {
      return (
        <button type="button" style={{ ...styles.buyBtn, opacity: 0.5, cursor: 'not-allowed' }} disabled title={t('membership.cart_error_awaiting_staff')}>
          {t('membership.cart_add')}
        </button>
      );
    }
    if (inCart.state === 'in_cart') {
      const item = [...cartItems(setView, viewerId, standaloneCart), ...standaloneCartItems(standaloneCart)]
        .find((i) => i.key === inCart.key);
      return (
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <StatusPill status="pending" label={t('membership.cart_in_cart')} />
          {item && (
            <button type="button" style={styles.draftSecondaryBtn} disabled={cartBusy !== null} onClick={() => removeCartItem(item)}>
              {t('membership.cart_item_cancel')}
            </button>
          )}
        </span>
      );
    }
    if (showsBuyAction(product)) {
      return (
        <button
          type="button"
          style={styles.buyBtn}
          onClick={() => openPurchase(product)}
        >
          {t('membership.cart_add')}
        </button>
      );
    }
    const stateKey = purchaseStateKey(product.purchase_state);
    const statusWord = purchaseStateStatusWord(product.purchase_state);
    if (!stateKey || !statusWord) return null;
    return <StatusPill status={statusWord} label={t(stateKey as any)} />;
  }

  /**
   * Add to cart, or the line it already is: Cancel for one this Draft added, a
   * pill for one held. #2771 — a recurring Product reads exactly as a one-time
   * one does (*Add to cart*, *In your cart*, *Cancel*): both join the one cart,
   * the member's Draft Product Set, and are paid by its one Pay. The recurring
   * line is still added straight to the Draft (no dialog: it takes no
   * recipient or Promotion choice there), nothing is charged by adding it.
   */
  function draftAction(product: MemberProduct) {
    const placed = draftProductState(product, setView);
    const busy = draftBusy !== null;
    const error = draftError?.productId === product.id ? draftError.key : null;
    // #3305: a cart staff are still preparing takes nothing from the member — no add, no Cancel.
    const locked = cartLockedForStaff(setView, viewerId, standaloneCart);
    let control: React.ReactNode;
    if (placed.state === 'added' && locked) {
      control = <StatusPill status="pending" label={t('membership.cart_in_cart')} />;
    } else if (locked && placed.state !== 'held') {
      control = (
        <button type="button" style={{ ...styles.buyBtn, opacity: 0.5, cursor: 'not-allowed' }} disabled title={t('membership.cart_error_awaiting_staff')}>
          {t('membership.cart_add')}
        </button>
      );
    } else if (placed.state === 'added') {
      control = (
        <>
          <StatusPill status="pending" label={t('membership.cart_in_cart')} />
          <button type="button" style={styles.draftSecondaryBtn} disabled={busy} onClick={() => removeFromDraft(product, placed.lineId)}>
            {t('membership.cart_item_cancel')}
          </button>
        </>
      );
    } else if (placed.state === 'held') {
      control = <StatusPill status="active" label={t('membership.product_state_held')} />;
    } else {
      control = (
        <button type="button" style={styles.buyBtn} disabled={busy} onClick={() => addToDraft(product)}>
          {draftBusy === product.id ? t('membership.cart_adding') : t('membership.cart_add')}
        </button>
      );
    }
    return (
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        {control}
        {error && <span role="alert" style={{ ...styles.draftError, flexBasis: '100%', textAlign: 'right' }}>{t(error as any)}</span>}
      </span>
    );
  }

  function openPurchase(product: MemberProduct) {
    setPurchaseError(null);
    // The buyer is the default recipient (#2609 §1): changing nothing buys for themself.
    setPurchaseAssignee(selfMemberId);
    setPurchasing(product);
  }

  function closePurchase() {
    setPurchasing(null);
    setPurchaseError(null);
  }

  /**
   * #2746 stage 2 — a one-time Product goes into the member's cart instead of
   * starting a payment of its own: nothing is charged until the cart's Pay (§2).
   * Since #2949 stage 6 it is a standalone purchase (`/me/cart/purchases`), never
   * linked to a Product Set; a Draft's Save & Pay pays it with the rest. The body names the
   * Product, the applied Promotion and who it is for — the route re-reads and
   * re-prices the Promotion (#1118 §8), so the browser never names a price.
   */
  async function confirmPurchase(product: MemberProduct) {
    setPurchaseSubmitting(true);
    setPurchaseError(null);
    try {
      const applied = appliedPromotionFor(product);
      // #2949 stage 6: a one-time Product enters the cart on its own (stage 4), never a
      // Product Set; the Draft's Save & Pay pays it with the rest when there is one (stage 5).
      await apiFetch('/me/cart/purchases', {
        method: 'POST',
        body: JSON.stringify({
          product_id: product.id,
          ...(applied ? { promotion_ids: [applied.promotion_id] } : {}),
          // #2609: the chosen family member, only when the dialog asked.
          ...assigneePayload(product, assignees, purchaseAssignee),
        }),
      });
      await loadSetView();
      setPurchasing(null);
    } catch (err: any) {
      // The API answers the refusal code, so the member reads it in their own
      // language; anything else falls back to the generic key.
      setPurchaseError(t(cartErrorKey(err?.message) as any));
    } finally {
      setPurchaseSubmitting(false);
    }
  }

  // ── #1122 — Add Plan ──────────────────────────────────────────────────────

  // #2737 — the Add Plan page shows the catalogue read with the page; a read
  // that failed is tried once more here rather than reading as "no plans".
  useEffect(() => {
    if (mode === 'add_plan' && !loading && planCatalogue === null) void openCatalogue();
  }, [mode, loading]);

  async function openCatalogue() {
    if (planCatalogue !== null) return;
    setCatalogueLoading(true);
    try {
      const res = await apiFetch<{ plans: MemberPlanOffer[]; family_members?: FamilyMemberOption[] }>('/me/membership-plans');
      setPlanCatalogue(res.plans);
      setPlanFamily(res.family_members ?? []);
    } catch {
      // Stays `null`: the control remains and a second open reads again.
    } finally {
      setCatalogueLoading(false);
    }
  }

  /** #3091 — the selection on screen for a plan (the default until the member changes it). */
  function beneficiariesOf(plan: MemberPlanOffer): number[] {
    return planBeneficiaries[plan.id] ?? defaultBeneficiaryIds(plan.member_limit, planFamily);
  }
  /** `beneficiary_member_ids` for the request; nothing is sent while the member has no family to choose from. */
  function beneficiaryBody(plan: MemberPlanOffer) {
    return offersBeneficiaryChoice(planFamily) ? { beneficiary_member_ids: beneficiariesOf(plan) } : {};
  }
  function beneficiaryErrorKey(plan: MemberPlanOffer): string | null {
    return offersBeneficiaryChoice(planFamily) ? beneficiaryCountErrorKey(plan.member_limit, beneficiariesOf(plan)) : null;
  }
  function renderBeneficiaries(plan: MemberPlanOffer) {
    if (!offersBeneficiaryChoice(planFamily)) return null;
    const selected = beneficiariesOf(plan);
    const errorKey = beneficiaryErrorKey(plan);
    return (
      <fieldset style={{ border: 'none', margin: '10px 0 0', padding: 0 }}>
        <legend style={{ fontSize: 12.5, fontWeight: 600, padding: 0 }}>{t('membership.beneficiaries_title')}</legend>
        {planFamily.map((m) => (
          <label key={m.member_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, padding: '3px 0' }}>
            <input
              type="checkbox"
              checked={selected.includes(m.member_id)}
              onChange={() => setPlanBeneficiaries((prev) => ({ ...prev, [plan.id]: toggleBeneficiary(selected, m.member_id) }))}
            />
            <span>{m.member_id === selfMemberId ? t('membership.beneficiaries_you', { name: m.name }) : m.name}</span>
          </label>
        ))}
        {errorKey && <span role="alert" style={{ fontSize: 12.5 }}>{t(errorKey as any)}</span>}
      </fieldset>
    );
  }

  function applyPlanPromotion(planId: number, promotionId: number) {
    setAppliedPlanPromotions((prev) => ({ ...prev, [planId]: promotionId }));
  }

  function togglePlanBenefit(planId: number, key: string) {
    const current = new Set(declinedPlanBenefits[planId] ?? []);
    if (current.has(key)) current.delete(key); else current.add(key);
    const next = Array.from(current);
    setDeclinedPlanBenefits((prev) => ({ ...prev, [planId]: next }));
    // #2495 — every figure is re-quoted by the engine; nothing is computed here.
    apiFetch<{ overview: MemberPlanOffer['overview'] }>(
      `/me/membership-plans/${planId}/overview${next.length ? `?declined=${next.join(',')}` : ''}`,
    ).then((res) => setOverviewOverrides((prev) => ({ ...prev, [planId]: res.overview })))
      .catch(() => { /* keep the last quote; the purchase still sends the selection */ });
  }

  /**
   * #2743 — `Choose this plan` creates the member's Draft at once (no confirmation
   * step) through `POST /me/membership-plans/:id/assign`, which starts no
   * payment, and returns to My Products, where the Draft is reviewed and paid
   * through its own Save & Pay. A refusal is shown on the plan card it came from.
   */
  async function choosePlan(plan: MemberPlanOffer) {
    if (choosingPlanId !== null) return;
    setChoosingPlanId(plan.id);
    setPlanDraftError(null);
    try {
      const applied = appliedPlanPromotions[plan.id] ?? null;
      await apiFetch(`/me/membership-plans/${plan.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          promotion_ids: applied ? [applied] : [],
          declined_benefits: declinedBenefitsPayload(plan.benefits, new Set(declinedPlanBenefits[plan.id] ?? [])),
          ...beneficiaryBody(plan),
        }),
      });
      // My Products reads the new Draft on mount; the button stays busy while
      // the page changes, so the Draft cannot be submitted twice.
      router.push(`/${locale}${MEMBERSHIP_PATH}`);
    } catch (err: any) {
      setPlanDraftError({ planId: plan.id, key: assignErrorKey(err?.message) });
      setChoosingPlanId(null);
    }
  }

  /**
   * The *Add plan* action and, while one exists, the plan awaiting its first
   * payment — above the current plan (§1), in both the with-plan and the
   * no-plan branches so the entry point is never missing.
   */
  function renderPlansHeader() {
    // #2814 — while the cart is shown the two actions live inside it.
    if (cartPhase(setView, appMember?.id ?? null, standaloneCart) != null) return null;
    const buttons = renderAddButtons(primaryButtonStyle);
    return buttons && <div style={styles.addPlanRow}>{buttons}</div>;
  }

  /**
   * #2814 — *Add plan* and *Add product*, the same two actions under the same
   * conditions wherever they are drawn: inside the cart (secondary, under its
   * items) while there is one, above the plans otherwise.
   */
  function renderAddButtons(style: React.CSSProperties, disabledReason: string | null = null) {
    if (mode !== 'overview' || !canAdd || !((!pendingMembership && gymOffersPlans) || products !== null)) return null;
    // #2895: disabled (never hidden) while another purchase is being prepared, with the reason beside them.
    const disabled = disabledReason != null;
    const btn = disabled ? { ...style, ...styles.busy } : style;
    return (
      <>
        {!pendingMembership && gymOffersPlans && (
          <button type="button" style={btn} disabled={disabled} title={disabledReason ?? undefined}
            onClick={() => router.push(`/${locale}${ADD_PLAN_PATH}`)}>
            {t('membership.add_plan')}
          </button>
        )}
        {products !== null && (
          <button type="button" style={btn} disabled={disabled} title={disabledReason ?? undefined}
            onClick={() => router.push(`/${locale}${ADD_PRODUCT_PATH}`)}>
            {t('membership.add_product')}
          </button>
        )}
      </>
    );
  }

  function renderCartAddButtons(disabledReason: string | null = null) {
    const buttons = renderAddButtons({ ...cartSecondaryButtonStyle, ...styles.cartItemBtn }, disabledReason);
    if (!buttons) return null;
    return (
      <>
        <div style={styles.cartAddRow} data-cart-add>{buttons}</div>
        {disabledReason && <p style={{ ...cartMutedStyle, margin: '8px 0 0' }} data-cart-add-reason>{disabledReason}</p>}
      </>
    );
  }

  // #2426 — the server's overview of a plan, worded and formatted here; every
  // figure is the engine's (`GET /me/membership-plans`), none is computed.
  function planOverviewView(plan: MemberPlanOffer): PlanOverviewView | null {
    const o = overviewOverrides[plan.id] ?? plan.overview;
    if (!o) return null;
    const bd = o.billing_duration;
    const freq = (f: string | null) => (f && ['once', 'week', 'four_weeks', 'month', 'year', 'per_session'].includes(f)
      ? t(`membership.frequency.${f}` as any) : null);
    return {
      durationHeading: t('membership.plan_ov_duration'),
      durationRows: [
        { label: t('membership.plan_ov_free'), value: String(bd.free_periods) },
        { label: t('membership.plan_ov_paid'), value: String(bd.paid_periods) },
        { label: t('membership.plan_ov_prepaid'), value: String(bd.prepaid_periods) },
        { label: t('membership.plan_ov_bonus'), value: String(bd.bonus_periods) },
        ...(bd.billing_interval != null && bd.billing_unit
          ? [{ label: t('membership.plan_ov_billing'), value: formatInterval(bd.billing_interval, bd.billing_unit, (k) => t(k as any)) }]
          : []),
        { label: t('membership.plan_ov_auto_renew'), value: t(bd.auto_renew ? 'membership.plan_ov_yes' : 'membership.plan_ov_no') },
      ],
      productsHeading: t('membership.plan_ov_products'),
      products: o.products.map((p) => {
        const note = p.action && p.action !== 'no_benefit'
          ? promotionBenefitNote(p.action, p.value, forecast.currency, gymFmt) : null;
        return {
          key: `${p.section}:${p.product_id}`,
          name: p.name,
          requirement: t(p.mandatory ? 'membership.plan_ov_mandatory' : 'membership.plan_ov_optional'),
          detail: [`${p.quantity} ×`, freq(p.frequency)].filter(Boolean).join(' · '),
          regularLabel: t('membership.plan_ov_regular'),
          regular: money(p.original_line_price_incl_tax) ?? '—',
          benefit: note ? t(note.key as any, note.values) : t('membership.plan_ov_no_benefit'),
          finalLabel: t('membership.plan_final_price'),
          final: p.declined ? '—' : (money(p.final_line_price_incl_tax) ?? '—'),
          imageUrl: p.image_url ?? null,
          imageFullUrl: p.image_full_url ?? null,
          declined: p.declined,
          placeholder: t('membership.plan_no_image'),
          checkbox: p.mandatory ? null : {
            checked: !p.declined,
            label: t('membership.plan_ov_include'),
            onToggle: () => togglePlanBenefit(plan.id, `${p.section}:${p.product_id}`),
          },
        };
      }),
      prepaid: o.prepaid_end_date
        ? { label: t('membership.plan_ov_prepaid_end'), value: formatGymDateOnly(o.prepaid_end_date, gymFmt) } : null,
      initial: o.initial_payment != null
        ? { label: t('membership.plan_ov_initial'), value: money(o.initial_payment) ?? '—' } : null,
      simulationHeading: t('membership.plan_ov_simulation'),
      simulationToggleLabel: t('membership.plan_ov_simulation'),
      simulation: o.simulation.dates.map((d) => ({
        key: d.date,
        date: formatGymDateOnly(d.date, gymFmt),
        total: money(d.total) ?? '—',
        lines: d.lines.map((l, i) => ({
          key: `${d.date}:${i}`,
          label: l.label,
          amount: money(l.actual_charge) ?? '—',
          note: l.regular_price !== l.actual_charge ? `${t('membership.plan_ov_regular')} ${money(l.regular_price) ?? '—'}` : null,
        })),
      })),
    };
  }

  /**
   * #2496 stage 4 — while the member is building a Draft, a plan joins that
   * Draft (one purchase with the Products on it); with no Draft the card keeps
   * its own purchase, which stage 5's single Save & Pay will replace.
   */
  function planAction(plan: MemberPlanOffer) {
    const control = planControl(plan);
    const error = planDraftError?.planId === plan.id ? planDraftError.key : null;
    if (!error) return control;
    return (
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        {control}
        <span role="alert" style={{ ...styles.draftError, flexBasis: '100%', textAlign: 'right' }}>{t(error as any)}</span>
      </span>
    );
  }

  function planControl(plan: MemberPlanOffer) {
    const placed = draftPlanState(plan.id, setView);
    const busy = draftBusy !== null;
    if (placed.state === 'no_draft') {
      return (
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={choosingPlanId !== null || beneficiaryErrorKey(plan) !== null}
          aria-busy={choosingPlanId === plan.id}
          onClick={() => choosePlan(plan)}
        >
          {choosingPlanId === plan.id ? t('membership.choose_plan_submitting') : t('membership.choose_plan')}
        </button>
      );
    }
    if (placed.state === 'added') {
      return (
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <StatusPill status="pending" label={t('membership.plan_in_draft')} />
          <button type="button" style={styles.draftSecondaryBtn} disabled={busy} onClick={() => removePlanFromDraft(plan.id, placed.planSnapshotId)}>
            {t('membership.plan_remove_from_draft')}
          </button>
          {/* #3312: the same plan may be added again, as another instance. */}
          <button type="button" style={styles.draftSecondaryBtn} disabled={busy || beneficiaryErrorKey(plan) !== null} onClick={() => addPlanToDraft(plan)}>
            {draftBusy === PLAN_BUSY ? t('membership.product_adding') : t('membership.plan_add_to_draft')}
          </button>
        </span>
      );
    }
    return (
      <button type="button" style={primaryButtonStyle} disabled={busy || beneficiaryErrorKey(plan) !== null} onClick={() => addPlanToDraft(plan)}>
        {draftBusy === PLAN_BUSY ? t('membership.product_adding') : t('membership.plan_add_to_draft')}
      </button>
    );
  }

  function renderPlanCatalogue() {
    const items: MemberPlanCardItem[] = (planCatalogue ?? []).map((plan) => {
      const applied = appliedPlanPromotions[plan.id] ?? null;
      const frequencyKey = planFrequencyKey(plan);
      return {
        key: String(plan.id),
        name: plan.name,
        description: plan.description,
        price: planPriceText(plan, gymFmt),
        frequency: frequencyKey
          ? t(frequencyKey as any)
          : (plan.billing_interval != null && plan.billing_unit ? formatInterval(plan.billing_interval, plan.billing_unit, t) : null),
        finalPriceLabel: t('membership.plan_final_price'),
        finalPrice: applied ? planFinalPriceText(plan, applied, gymFmt) : null,
        imageUrl: plan.image_url ?? null,
        imageFullUrl: plan.image_full_url ?? null,
        includedLabel: t('membership.plan_included'),
        included: (overviewOverrides[plan.id] ?? plan.overview)?.products.filter((p) => p.mandatory).map((p) => p.name).join(', ') || null,
        optionalLabel: t('membership.plan_optional'),
        optional: (overviewOverrides[plan.id] ?? plan.overview)?.products.filter((p) => !p.mandatory).map((p) => p.name).join(', ') || null,
        initial: (overviewOverrides[plan.id] ?? plan.overview)?.initial_payment != null
          ? { label: t('membership.plan_ov_initial'), value: money((overviewOverrides[plan.id] ?? plan.overview)!.initial_payment) ?? '—' }
          : null,
        overview: planOverviewView(plan),
        beneficiaries: renderBeneficiaries(plan),
        promotions: plan.promotions.map((promotion) => {
          const benefit = planPromotionBenefitNote(promotion, gymFmt);
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
        action: planAction(plan),
      };
    });
    return (
      <MemberPlanCatalogue
        title={t('membership.add_plan_title')}
        emptyLabel={catalogueLoading ? t('membership.add_plan_loading') : t('membership.add_plan_empty')}
        items={items}
        onClose={() => router.push(`/${locale}${MEMBERSHIP_PATH}`)}
        closeLabel={t('membership.add_plan_close')}
      />
    );
  }

  /** #3297 — a payment's status pill: the event's own status, derived once by the API (#640). */
  function paymentStatusPill(event: BillingEvent) {
    // #3332: an event that records no payment has no status, so no pill.
    if (!event.status) return null;
    return (
      <span style={statusPillStyle(statusTone(event.status))}>
        {t(`payments.status.${event.status}` as any)}
      </span>
    );
  }

  /** #2937 — a payment's own stored lines, as the ledger priced them. */
  function paymentCardLines(event: BillingEvent): BillingEventCardLine[] {
    return (event.lines ?? []).map((line) => ({
      key: String(line.id),
      heading: t(`payments.${lineKindKey(line)}` as any),
      name: line.item_name,
      meta: [
        line.quantity > 1 ? t('payments.quantity', { count: line.quantity }) : null,
        line.promotion_name,
      ].filter(Boolean).join(' · ') || null,
      amount: money(billingEventLineAmount(line)),
      regularAmount: money(billingEventLineRegularAmount(line)),
    }));
  }

  /** #2937 / #3297 — a payment's title, notes, chips and details, shared by both payment layouts. */
  function paymentTitle(event: BillingEvent): string {
    // #2940: the event's own name when it has one; an event written before names
    // existed keeps the label it had.
    return event.name
      ?? (t(`membership.event.${event.event_type}` as any)
        + (event.charge_type_code ? ` · ${t(`membership.charge_type.${event.charge_type_code}` as any)}` : ''));
  }

  function paymentNotes(event: BillingEvent): string | null {
    const transition = event.event_type === 'status_changed' && event.new_status
      ? `${event.previous_status ? t(`membership.status.${event.previous_status}` as any) : '—'}`
        + ` → ${t(`membership.status.${event.new_status}` as any)}`
      : null;
    return [transition, event.notes].filter(Boolean).join(' · ') || null;
  }

  function paymentChips(event: BillingEvent) {
    const paymentKey = paymentTypeKey(event);
    const refundKey = refundTypeKey(event);
    if (!paymentKey && !refundKey) return null;
    return (
      <>
        {paymentKey && <span style={statusPillStyle('neutral')}>{t(`payments.${paymentKey}` as any)}</span>}
        {refundKey && <span style={statusPillStyle('info')}>{t(`payments.${refundKey}` as any)}</span>}
      </>
    );
  }

  function paymentDetails(event: BillingEvent) {
    const notes = paymentNotes(event);
    if (!event.payment_method_name && !notes) return null;
    return (
      <>
        {event.payment_method_name && <span>{event.payment_method_name}</span>}
        {notes && <span>{notes}</span>}
      </>
    );
  }

  /**
   * #3299 — one past payment on the same detailed card Next Payment draws (not
   * prominent): its name, scheduled date, status and type chips, total, its own
   * stored lines, its documents and the payment details. Nothing is collapsed
   * inside it; the Past Payments subcard is what opens and closes.
   */
  function renderPastPaymentCard(event: BillingEvent) {
    return (
      <BillingEventCard
        key={event.id}
        title={paymentTitle(event)}
        date={formatPaymentDate(paymentScheduledDate(event), gymFmt)}
        total={money(billingEventAmount(event))}
        totalLabel={t('payments.total')}
        lines={paymentCardLines(event)}
        badge={(
          <BillingEventBadges>
            {paymentStatusPill(event)}
            {paymentChips(event)}
          </BillingEventBadges>
        )}
        documents={renderPaymentDocuments(event)}
        details={paymentDetails(event)}
      />
    );
  }

  /**
   * #2937 / #3297 — a compact payment row (Next Payment's further unresolved
   * payments, Planned Payments): title, scheduled date, status, chips and amount
   * in the header; lines, documents and details once expanded. Every figure is
   * the ledger's.
   */
  function renderPaymentRow(event: BillingEvent, opts: { anchorId?: string; highlighted?: boolean } = {}) {
    return (
      <PastBillingEventRow
        key={event.id}
        anchorId={opts.anchorId}
        highlighted={opts.highlighted}
        title={paymentTitle(event)}
        date={formatPaymentDate(paymentScheduledDate(event), gymFmt)}
        status={paymentStatusPill(event)}
        chips={paymentChips(event)}
        amount={money(billingEventAmount(event))}
        lines={paymentCardLines(event)}
        documents={renderPaymentDocuments(event)}
        expandable={billingEventHasDetails(event)}
        details={paymentDetails(event)}
      />
    );
  }

  /**
   * The purchase confirmation and the payment consent. Rendered by *every*
   * branch of the page that can raise them: a member with no live plan but a
   * plan awaiting payment (#1288) takes the `!membership` branch, and a dialog
   * kept only in the main return left its *Pay now* with nothing to open (#1081).
   */
  function renderDialogs() {
    return (
      <>
          {/* #1121 stage 2 §5/§8 — the member sees the final price before paying, in
              the app's own dialog (#1115: one dialog shell, not a second overlay).
              It asks nothing: the price, the frequency and the package note are the
              ones the card already showed, resolved once above. */}
          {purchasing && (
            <MemberDialog
              labelledBy="product-purchase-title"
              title={t('membership.cart_add_title')}
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
                      ? t('membership.cart_adding')
                      : t('membership.cart_add_confirm')}
                  </button>
                </>
              )}
            >
              <p style={styles.modalBody}>
                {/* §8: the member must always see the **actual** final price before
                    completing the purchase — so the dialog quotes the price with
                    their applied Promotion, exactly as the card does. */}
                {t('membership.cart_add_body', {
                  name: purchasing.name,
                  price: productFinalPriceText(purchasing, appliedPromotionFor(purchasing), gymFmt) ?? '—',
                })}
              </p>
              {showsAssigneeChoice(purchasing, assignees) && (
                <label style={styles.assigneeField}>
                  <span style={styles.assigneeLabel}>{t('membership.product_assignee_label')}</span>
                  <select
                    style={inputStyle}
                    value={purchaseAssignee ?? ''}
                    onChange={(e) => setPurchaseAssignee(Number(e.target.value))}
                    disabled={purchaseSubmitting}
                  >
                    {assigneeOptions(assignees, selfMemberId).map((a) => (
                      <option key={a.member_id} value={a.member_id}>
                        {a.member_id === selfMemberId ? t('membership.product_assignee_self', { name: a.name }) : a.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p style={styles.hintLeft}>{t('membership.cart_add_hint')}</p>
              {purchaseError && <p style={styles.submitError}>{purchaseError}</p>}
            </MemberDialog>
          )}

          {/* #2746 stage 3 — cancelling a cart awaiting payment cancels the whole purchase (#2747), so it asks first. */}
          {confirmPendingCancel && (
            <MemberDialog
              labelledBy="cart-pending-cancel-title"
              title={t('membership.cart_pending_cancel_title')}
              onClose={commitBusy ? () => {} : () => setConfirmPendingCancel(false)}
              actions={(
                <>
                  <button
                    type="button"
                    style={styles.dialogSecondary}
                    onClick={() => setConfirmPendingCancel(false)}
                    disabled={commitBusy}
                  >
                    {t('membership.cart_pending_cancel_keep')}
                  </button>
                  <button
                    type="button"
                    style={{ ...styles.dialogPrimary, ...(commitBusy ? styles.busy : null) }}
                    onClick={cancelPendingCart}
                    disabled={commitBusy}
                  >
                    {t('membership.cart_pending_cancel_confirm')}
                  </button>
                </>
              )}
            >
              <p style={styles.modalBody}>{t('membership.cart_pending_cancel_body')}</p>
            </MemberDialog>
          )}

          {/* Consent modal */}
          {consentOpen && (
            <div style={styles.overlay} onClick={() => !submitting && setConsentOpen(false)}>
              <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
                <h2 style={styles.modalTitle}>{t(consentRecurring ? 'payment_consent.title' : 'payment_consent.title_once')}</h2>
                <p style={styles.modalBody}>
                  {consentRecurring
                      ? t('payment_consent.body', {
                          gymName: gymName ?? '—',
                          amount: consentAmount,
                          currency: consentCurrency,
                          interval: formatInterval(consentInterval as number, consentUnit as string, (k) => t(k as any)),
                        })
                      : t('payment_consent.body_once', {
                          gymName: gymName ?? '—',
                          amount: consentAmount,
                          currency: consentCurrency,
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
                  {t(consentRecurring ? 'payment_consent.checkbox' : 'payment_consent.checkbox_once')}
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
      </>
    );
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

  // #2737 — the two purchasing pages: only their own catalogue, the dialogs it
  // opens and a way back. Everything the member already holds is My Products'.
  // #2770 — a family member who is not the owner reaches neither purchasing page,
  // even by typing its address: the page says why and offers nothing to add.
  if ((mode === 'add_plan' || mode === 'add_product') && !canAdd) {
    return (
      <main style={styles.container}>
        <p style={noticeStyle('info')}>{t(FAMILY_OWNER_ONLY_KEY as any)}</p>
      </main>
    );
  }

  if (mode === 'add_plan') {
    return (
      <main style={styles.container}>
        {renderPlansHeader()}
        {renderPlanCatalogue()}
        {renderDialogs()}
      </main>
    );
  }

  if (mode === 'add_product') {
    return (
      <main style={styles.container}>
        {renderCart()}
        {renderSetSummary()}
        {renderProducts()}
        {products === null && <p style={styles.hint}>{t('membership.products_empty')}</p>}
        {renderDialogs()}
      </main>
    );
  }

  if (!membership) {
    // A member may hold no plan at all (#956), and the catalogue is the gym's
    // rather than the plan's — so the products still belong on this screen.
    return (
      <main style={styles.container}>
        {renderTabs()}
        {tab === 'services' ? renderServicesTab() : tab === 'payments' && paymentsVisible ? renderPaymentsTab() : (<>
        {renderCart()}
        {renderSetSummary()}
        {renderPlansHeader()}
        {renderMyPlans()}
        {renderMyProducts()}
        {renderOwnPurchases()}
        </>)}
        {renderDialogs()}
      </main>
    );
  }

  return (
    <main style={styles.container}>
      {renderTabs()}
      {tab === 'services' ? renderServicesTab() : tab === 'payments' && paymentsVisible ? renderPaymentsTab() : (<>
      {/* #2746 stage 2 — the cart, at the top of My Products. */}
      {renderCart()}
      {/* #2894 — the Summary, collapsible, before My Plans and My Products. */}
      {renderSetSummary()}
      {/* #1122 §1 — Add plan above the current plan, and the plan awaiting
          its first payment while one exists. */}
      {renderPlansHeader()}

      {/* #2663 — My Plans, then My Products, both from the one selected version. */}
      {renderMyPlans()}
      {renderMyProducts()}

      {/* #1121 §3 — Additional Products and Services, directly below the
          membership card. (#3294 removed the "Make a payment" button that sat
          between them; payments go through the cart and the Payments tab.) */}
      {renderOwnPurchases()}

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

      {/* #1775 — Past Membership Plans close the page: secondary history,
          collapsed and muted, below everything the member acts on. */}
      {renderPastPlans()}
      </>)}

      {renderDialogs()}
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
  card: { ...sectionCardStyle, padding: 20 },
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
  // #1776: the plan's benefits sit inside its card, indented and on a tinted
  // inner surface, so they read as the plan's own rather than a sibling.
  benefitList: { listStyle: 'none', padding: 0, margin: 0 },
  benefitItem: { ...sectionCardStyle, padding: '10px 14px', marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' },
  benefitMeta: { fontSize: 13, color: memberTheme.textMuted },
  // #2892 — My Plans' expanded lines: no card per item. #3292 — spacing, not
  // hairlines, separates the items; the Product's name is the line's bold lead.
  planLines: { marginTop: 12 },
  planLineGroup: { marginBottom: 14 },
  planLineGroupLabel: { margin: '0 0 4px', fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: memberTheme.textMuted },
  planLine: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', marginBottom: 6 },
  planLineText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  planLineName: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 13, fontWeight: 700, color: memberTheme.text, overflowWrap: 'anywhere' },
  planLineMeta: { fontSize: 12, color: memberTheme.textMuted },
  viewPaymentRow: { display: 'flex', justifyContent: 'flex-end', marginBottom: 8 },
  benefitThumb: { width: 36, height: 36, flexShrink: 0, padding: 0, border: 'none', background: 'none', borderRadius: 8, overflow: 'hidden', display: 'block' },
  benefitThumbImg: { width: 36, height: 36, objectFit: 'cover', display: 'block' },
  eventList: { listStyle: 'none', padding: 0, margin: 0 },
  // #2894 — the Summary's compact, linear body: small labels, hairline rows, no nested cards.
  summaryBody: { padding: '0 16px 14px', fontSize: 13 },
  summaryLabel: { margin: '10px 0 4px', fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: memberTheme.textMuted },
  summaryHint: { margin: 0, fontSize: 13, color: memberTheme.textMuted },
  summaryList: { listStyle: 'none', padding: 0, margin: 0 },
  summaryItem: { ...rowDividerStyle, padding: '5px 0', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' },
  summaryLine: { ...rowDividerStyle, padding: '5px 0' },
  summaryText: { fontSize: 13, color: memberTheme.text },
  summaryAmount: { fontSize: 13, fontVariantNumeric: 'tabular-nums', color: memberTheme.text },
  summarySub: { fontSize: 11.5, color: memberTheme.textMuted, marginTop: 2 },
  summaryTotal: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingTop: 8 },
  eventItem: { ...sectionCardStyle, padding: '12px 14px', marginBottom: 6 },
  eventLine: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  eventLabel: { fontSize: 14, fontWeight: 500, color: memberTheme.text },
  eventAmount: { fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  eventSub: { fontSize: 12, color: memberTheme.textMuted, marginTop: 4 },
  // #1122 — the Add plan row, the plan awaiting its first payment, and the
  // choose dialog's text. Every colour is the theme's (#983).
  addPlanRow: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginBottom: 12 },
  planList: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  planPendingPayment: { ...noticeStyle('warning'), display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 10px' },
  planPendingText: { flex: '1 1 160px', fontSize: 13, fontWeight: 600 },
  planPendingActions: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  emptyCard: { ...sectionCardStyle, padding: '40px 24px', textAlign: 'center' },
  emptyTitle: { margin: '8px 0 12px', fontSize: 20, fontWeight: 700 },
  hint: { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: 0 },
  // Payment banner
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
  // #2746 stage 2 — the cart card's layout; its colours are memberChrome's.
  cartTop: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 14 },
  cartInfo: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px', minWidth: 0 },
  cartActions: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  cartBtn: { padding: '11px 22px', fontSize: 15, fontWeight: 700 },
  cartList: { listStyle: 'none', margin: '14px 0 0', padding: '10px 0 0', display: 'flex', flexDirection: 'column', gap: 8 },
  cartItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  cartItemName: { fontSize: 14, minWidth: 0, overflowWrap: 'anywhere' },
  cartItemBtn: { padding: '6px 12px', fontSize: 13, fontWeight: 600 },
  cartAddRow: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-start', gap: 8, marginTop: 12 },
  draftSecondaryBtn: { ...secondaryButtonStyle, padding: '8px 14px', fontSize: 13.5, fontWeight: 600 },
  draftError: { fontSize: 12.5, color: memberTheme.statusError },
  draftExpiry: { fontSize: 12.5, color: memberTheme.textSecondary },
  draftExpiryWarning: { fontSize: 12.5, fontWeight: 600, color: memberTheme.statusWarning },
  // #1118 §4/§17 — *Apply promotion* is an obvious action but a secondary one:
  // Buy is the card's primary, and two filled buttons on one card compete. Both
  // come from `memberChrome.ts`, so neither spells a colour (#983).
  promotionBtn: { ...secondaryButtonStyle, padding: '7px 14px', fontSize: 13, fontWeight: 600 },
  promotionApplied: { fontSize: 13, fontWeight: 600, color: memberTheme.textSecondary },
  dialogPrimary: { ...primaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 },
  dialogSecondary: { ...secondaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 },
  busy: { opacity: 0.6, cursor: 'default' },
  hintLeft: { margin: 0, fontSize: 12.5, color: memberTheme.textMuted },
  assigneeField: { display: 'flex', flexDirection: 'column', gap: 6, margin: '0 0 14px' },
  assigneeLabel: { fontSize: 13, fontWeight: 600, color: memberTheme.textSecondary },
  confirmBtn: { ...primaryButtonStyle, padding: '10px 20px', fontSize: 14, fontWeight: 600, transition: 'opacity 0.15s' },
};
