'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { listNameBadgeStyle, listNameBadgeAccentStyle } from '@/components/listChrome';
import { StatusBadge } from '@/components/StatusBadge';
import { formatGymDateOnly } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { clerkStatusLine, clerkInvitationLine, type ClerkAccountFields, type ClerkAccountLine } from '@/lib/clerkAccountLines';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SectionEditButton } from '@/components/SectionEditButton';
import {
  cardMutedTextStyle,
  cardSectionDividedStyle,
  cardSectionLabelStyle,
  cardSectionStyle,
  cardSubLabelStyle,
  cardTextLinkStyle,
  formFieldLabelStyle,
  innerCardStyle,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import { AssignPlanInlineEditor } from './AssignPlanInlineEditor';
import {
  MemberPurchasedProducts,
  type PurchasedProduct,
} from './MemberPurchasedProducts';
import { MemberPersonalTrainingSlots } from './MemberPersonalTrainingSlots';
import { MemberMembershipPlans } from './MemberMembershipPlans';
import { useProductSetDetail } from './MemberProductSet';
import { ProductSetsInFlight } from './ProductSetsInFlight';
import { ProposedSetForecast } from './ProposedSetForecast';
import { ProductsWorkflowBar, ProductsWorkflowActions, useDraftReview } from './MemberProductsWorkflow';
import { billingMode, pendingOneOffCount, saveAndPayTarget, standaloneCartCount } from './productsWorkflowView';
import { StandaloneCartSummary } from './StandaloneCartSummary';
import { ReviewChangesModal } from './ReviewChangesModal';
import { StandaloneCartPayModal } from './StandaloneCartPayModal';
import { MemberProgress } from './MemberProgress';
import { MemberPayments } from './MemberPayments';
import { MemberPurchases } from './MemberPurchases';
import { MemberBookings } from './MemberBookings';
import { MemberFamily } from './MemberFamily';
import { NewNutritionPlanDialog } from '../nutrition/NewNutritionPlanDialog';
import { NutritionPlanTree, type Hierarchy } from '../nutrition/nutrition-plan-templates/NutritionPlanTree';
import { MemberPersonalGoals } from '@/components/personalGoals/MemberPersonalGoals';
import { EMPTY_CONFIGURATION, type MemberConfiguration, type MemberPlanRow } from './membershipConfiguration';
import {
  formatProfileDate,
  memberGenderLabelKey,
  newMemberAnnounceKey,
  newMemberValueKey,
  type MemberProfile,
} from './memberProfile';
import { MemberCenterAccess } from './MemberCenterAccess';
import { MemberProfileLayout, NewMemberValue, WelcomedValue, statusChipRowStyle, profileValueStyle } from './MemberProfileLayout';
import { MemberImagePreview, memberImagePreviewSrc } from '@/components/MemberImageField';
import type { MemberTabId } from './memberTabs';
import { MemberProfessionalServices } from './MemberProfessionalServices';
import { NewTrainingPlanDialog } from '../training-plans/NewTrainingPlanDialog';
import { PlanWorkoutTree, type Workout } from '../training-plans/PlanWorkoutTree';

interface Plan {
  id: number;
  name: string;
}

interface TrainingPlanAssignment {
  id: number;
  training_plan_id: number;
  training_plan_name: string;
  status: 'active' | 'completed' | 'cancelled' | 'expired' | 'draft';
  valid_from: string | null;
  valid_to: string | null;
}

interface NutritionPlan {
  id: number;
  name: string;
  status: string;
  start_date?: string | null;
  end_date?: string | null;
}

/** `GET /members/:memberId/centers` — the sole-active-center fallback included (#797). */
interface MemberCenter {
  center_id: number;
  name: string;
  is_default: boolean | number;
}

export function MemberExpandedRow({
  memberId,
  member,
  tab,
  profileVersion,
  accountVersion = 0,
  editing,
  canManageTraining,
  canWriteMembers,
  canManagePackages,
  canManagePersonalGoals,
  canManageNutrition,
  onEditProfile,
  isAdmin,
  plans,
  statuses,
}: {
  memberId: number;
  /** #1327: the three header statuses, shown as chips in the Account section. */
  statuses?: { key: string; status: string | null; label: string }[];
  /**
   * #797: the Member's persisted Profile, as the Members list read it. The
   * PROFILE section renders it read-only; it is deliberately the same row the
   * `⋮ → Edit` form is seeded from, so the two can never show different data.
   */
  member: MemberProfile & { email?: string | null };
  /**
   * #961: the work area on screen. Only this tab's sections are rendered —
   * which ones those are is `MEMBER_TABS` in `memberTabs.ts`, so a section is
   * never shown by two tabs and never by none. The page owns the state, so the
   * selected tab survives a save, an edit and the URL (`?member=&tab=`).
   */
  tab: MemberTabId;
  /** Bumped by the page when an edit was saved, so the centers below are re-read. */
  profileVersion: number;
  accountVersion?: number;
  /**
   * #882: the inline Edit form is open above this row. It renders the Profile
   * itself, in this same layout, so the read-only PROFILE section below stands
   * down rather than showing the Member's Profile twice on one page.
   */
  editing: boolean;
  canManageTraining: boolean;
  /** Members write access: gates `+ Add Product` (#1521). */
  canWriteMembers: boolean;
  canManagePackages: boolean;
  /**
   * #948 §4: write access to the PERSONAL GOALS section — NUTRITION, read
   * through `nutrition.personal_goals`'s own permission override (#1070), which
   * is what `/member-personal-goals` enforces.
   */
  canManagePersonalGoals: boolean;
  /** #1428: the Nutrition Plans section's Edit button is offered to roles that can write NUTRITION. */
  canManageNutrition: boolean;
  /** #1428: opens the Profile's inline form; `undefined` for a role that cannot write Members. */
  onEditProfile?: () => void;
  isAdmin: boolean;
  plans: Plan[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const gymFmt = useGymFormatSettings();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const loadedRef = useRef(false);

  const [loading, setLoading] = useState(true);
  // #1962: the existing New Training Plan dialog, launched from the empty state.
  const [assignTrainingOpen, setAssignTrainingOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // #634 — the Member's Membership configuration: the Member's plans and their
  // additional services in one read, feeding two of the sections below.
  const [configuration, setConfiguration] = useState<MemberConfiguration>(EMPTY_CONFIGURATION);
  // #1463 — the current ProductSet's frozen products and forecast (read-only).
  const productSetDetail = useProductSetDetail(tab === 'products_services' ? configuration.current_product_set : null, configuration);
  const [cancelling, setCancelling] = useState<MemberPlanRow | null>(null);
  // #2481: the access end date the server will apply, fetched when the dialog opens.
  const [cancelEndsOn, setCancelEndsOn] = useState<string | null>(null);
  useEffect(() => {
    setCancelEndsOn(null);
    if (!cancelling || cancelling.status === 'in_cart' || cancelling.status === 'to_be_canceled') return;
    let live = true;
    apiFetch<{ ends_on: string | null }>(`/user-memberships/${cancelling.id}/cancellation-preview`)
      .then((r) => { if (live) setCancelEndsOn(r.ends_on); }).catch(() => {});
    return () => { live = false; };
  }, [cancelling]);
  const [assigningFor, setAssigningFor] = useState<MemberPlanRow | null>(null);
  // #629/#634 §12: the simulation must always reflect the current configuration,
  // so remounting it is how a change in either section above re-runs it.

  const [centers, setCenters] = useState<MemberCenter[]>([]);
  const [clerkStatus, setClerkStatus] = useState<({ status: string } & ClerkAccountFields) | null>(null);
  const [trainingPlans, setTrainingPlans] = useState<TrainingPlanAssignment[]>([]);
  const [nutritionPlans, setNutritionPlans] = useState<NutritionPlan[]>([]);
  // #1963 — the inactive plan groups start collapsed.
  const [trainingInactiveOpen, setTrainingInactiveOpen] = useState(false);
  const [nutritionInactiveOpen, setNutritionInactiveOpen] = useState(false);
  const [assignNutritionOpen, setAssignNutritionOpen] = useState(false);
  // #2132: expandable read-only plan cards, rendered by the Assigned Nutrition Plans tree.
  const [nutritionExpanded, setNutritionExpanded] = useState<Set<number>>(new Set());
  const [nutritionHierarchies, setNutritionHierarchies] = useState<Record<number, Hierarchy>>({});

  // #1118 §12 — the Products this Member bought from the Members App, each with
  // the Promotion snapshot it was bought under.
  const [purchasedProducts, setPurchasedProducts] = useState<PurchasedProduct[]>([]);
  // #1537: the Draft is the member's own in-flight version (created on first use).
  // #1613 — the in-flight version (Draft or awaiting payment) whose simulation is shown.
  const inFlightSetId = ['in_cart', 'pending_payment'].includes(configuration.current_product_set?.status ?? '') && !configuration.current_product_set?.expired
    ? configuration.current_product_set!.id : null;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [committedKey, setCommittedKey] = useState(0);
  const draftReview = useDraftReview(configuration.current_product_set, configuration);
  const workflow = {
    current: configuration.current_product_set,
    review: draftReview,
    pendingOneOffs: pendingOneOffCount(purchasedProducts),
    // #2965 — standalone one-time Products waiting in the cart: a Draft's Save & Pay pays them,
    // and with no Draft they are a cart of their own with its own Summary.
    cartPurchases: standaloneCartCount(purchasedProducts),
  };
  const [cartPaymentLink, setCartPaymentLink] = useState<string | null>(null);
  // #3313 — the standalone cart's Save & Pay opens the payment step; only its Pay creates the
  // Billing Event and the Members App checkout (`StandaloneCartPayModal`).
  const [cartPayOpen, setCartPayOpen] = useState(false);
  async function cartPaid(checkoutUrl: string) {
    setCartPayOpen(false);
    setCartPaymentLink(checkoutUrl);
    try { await navigator.clipboard?.writeText(checkoutUrl); } catch { /* shown on screen */ }
    await reloadProducts();
  }
  const billingSectionMode = billingMode(workflow);
  const inFlightSetsShown = (configuration.product_sets ?? []).some((p: any) => p.status === 'in_cart' || p.status === 'pending_payment');

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadAll();
  }, []);

  // #797: an edit saved on this row may have reassigned the Member's centers.
  // Only that read is repeated — remounting would re-fetch every other section.
  useEffect(() => {
    if (profileVersion === 0) return;
    loadCenters();
  }, [profileVersion]);

  // #1326: invite / re-invite / revoke happen outside this row; re-read only the Clerk status.
  useEffect(() => {
    if (accountVersion === 0) return;
    apiFetch<{ status: string } & ClerkAccountFields>(`/members/${memberId}/clerk-status`)
      .then(setClerkStatus)
      .catch(() => {});
  }, [accountVersion]);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [
        config, memberTrainingPlans, nutrition, clerk, memberCenters, purchases,
      ] = await Promise.all([
        apiFetch<MemberConfiguration>(`/user-memberships/member/${memberId}/configuration`)
          .catch(() => EMPTY_CONFIGURATION),
        canManageTraining
          ? apiFetch<TrainingPlanAssignment[]>(`/members/${memberId}/member-training-plans`).catch(() => [])
          : Promise.resolve([]),
        apiFetch<NutritionPlan[]>(`/member-nutrition-plans?member_id=${memberId}`).catch(() => []),
        apiFetch<{ status: string } & ClerkAccountFields>(`/members/${memberId}/clerk-status`).catch(() => null),
        apiFetch<MemberCenter[]>(`/members/${memberId}/centers`).catch(() => []),
        apiFetch<{ items: PurchasedProduct[] }>(`/members/${memberId}/products`)
          .catch(() => ({ items: [] })),
      ]);

      setConfiguration(config);
      setPurchasedProducts(purchases.items ?? []);
      setClerkStatus(clerk);
      setTrainingPlans(memberTrainingPlans);
      setNutritionPlans(nutrition);
      setCenters(memberCenters);
    } catch {
      setError(t('members.expanded_error'));
    } finally {
      setLoading(false);
    }
  }

  async function loadCenters() {
    try {
      setCenters(await apiFetch<MemberCenter[]>(`/members/${memberId}/centers`));
    } catch {
      // Leave the last known assignment on screen: an empty list would read as
      // "no centers", which is a different statement from "could not load".
    }
  }

  /** #1521: a purchase or a version changed — re-read what the Products tab shows. */
  async function reloadProducts() {
    try {
      const purchases = await apiFetch<{ items: PurchasedProduct[] }>(`/members/${memberId}/products`);
      setPurchasedProducts(purchases.items ?? []);
    } catch {
      // Keep the last known list rather than an empty one that reads as "none".
    }
    await reloadConfiguration();
  }

  // #634 §12: every change in the MEMBERSHIP PLANS or ADDITIONAL PRODUCTS
  // sections lands here — it re-reads the configuration both are rendered from. The other expanded-row
  // sections (training plans, packages, billing events) are left alone.
  async function reloadConfiguration() {
    try {
      setConfiguration(await apiFetch<MemberConfiguration>(`/user-memberships/member/${memberId}/configuration`));
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'));
    }
  }

  async function handleCancelPlan() {
    if (!cancelling) return;
    try {
      // #1706: a Draft is discarded (hard delete, nothing billed); any other status keeps the cancel path.
      const isDraft = cancelling.status === 'in_cart';
      if (cancelling.status === 'to_be_canceled') {
        // #3007: undo a pending cancellation; the plan was never cancelled.
        await apiFetch(`/user-memberships/${cancelling.id}/unmark-cancel`, { method: 'POST', body: JSON.stringify({}) });
      } else if (!isDraft && cancelling.status === 'active') {
        // #3007: Cancel Plan marks the plan in the member's open Draft; it ends at Save & Pay.
        await apiFetch(`/user-memberships/${cancelling.id}/mark-cancel`, { method: 'POST', body: JSON.stringify({}) });
      } else {
        await apiFetch(`/user-memberships/${cancelling.id}${isDraft ? '/draft' : ''}`, { method: 'DELETE' });
      }
      setCancelling(null);
      reloadConfiguration();
    } catch (err: any) {
      setCancelling(null);
      toast(err.message ?? t('members.error_generic'));
    }
  }

  // #3114: Reactivate marks a plan cancelling at its period end in the member's open In Cart (nothing
  // changes, and nothing is charged or audited, until Save & Pay); the same menu item un-marks it.
  async function handleReactivatePlan(plan: { id: number }, action: 'mark' | 'unmark') {
    try {
      await apiFetch(`/user-memberships/${plan.id}/${action}-reactivate`, { method: 'POST', body: JSON.stringify({}) });
      reloadConfiguration();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'));
    }
  }


  if (loading) {
    return <div style={panel}><p style={dim}>{t('members.expanded_loading')}</p></div>;
  }

  if (error) {
    return (
      <div style={panel}>
        <p style={{ color: '#c0392b', fontSize: 14, margin: 0 }}>
          {error}{' '}
          <button onClick={loadAll} style={retryBtn}>{t('members.retry')}</button>
        </p>
      </div>
    );
  }

  const activePlans = trainingPlans.filter((p) => p.status === 'active');
  const inactivePlans = trainingPlans.filter((p) => p.status !== 'active');

  const defaultCenter = centers.find((c) => !!c.is_default);

  return (
    <div style={panel}>

      {tab === 'profile' && (
        <>
          {/* #797 — PROFILE: the complete persisted Member Profile, read-only.
              Expanding a Member is for reading it; editing stays behind ⋮ → Edit,
              so this section carries no input, no toggle and no Edit affordance.

              #882 — and it reads in the layout the Edit form writes in: the same
              grid, order, labels and full-width Notes, from MemberProfileLayout.
              While that form is open above, this section steps aside rather than
              showing the same Profile a second time. */}
          {!editing && (
            <Section label={t('members.section_profile')} divider={false}>
              {/* #1428: the Profile's own Edit button replaces the Member
                  menu's `⋮ → Edit`; absent for a role that cannot write. */}
              {onEditProfile && (
                <div style={{ marginBottom: 8 }}>
                  <SectionEditButton label={t('members.edit')} onClick={onEditProfile} />
                </div>
              )}
              <div style={card}>
                <MemberProfileLayout
                  /* #1374: the image is a value here — the same frame the Edit
                     form draws its control in, with no upload and no remove. */
                  image={{
                    label: t('members.label_image'),
                    content: (
                      <MemberImagePreview
                        src={memberImagePreviewSrc(member.image_url, member.modified_at)}
                        emptyLabel={t('members.image_none')}
                      />
                    ),
                  }}
                  fieldLabel={(f) => t(`members.${f.labelKey}`)}
                  renderField={(f) => (
                    <p style={profileValueStyle}>
                      {(f.kind === 'date'
                        ? formatProfileDate(member[f.key], gymFmt)
                        : f.kind === 'gender' && memberGenderLabelKey(member[f.key])
                          ? t(`members.${memberGenderLabelKey(member[f.key])}`)
                          : member[f.key]?.trim()) || EMPTY_VALUE}
                    </p>
                  )}
                  /* #927: calculated by the server from the Member's Membership
                     history and read off the same row as every other value here —
                     so the Profile, the member header's badge and the Promotion
                     apply paths can never disagree about who is new. */
                  renderCalculated={() => (
                    <span style={statusChipRowStyle}>
                      <NewMemberValue
                        isNewMember={member.is_new_member}
                        label={t(`members.${newMemberValueKey(member.is_new_member)}`)}
                        announce={t(`members.${newMemberAnnounceKey(member.is_new_member)}`)}
                      />
                      <WelcomedValue
                        label={t('members.label_welcomed')}
                        value={member.welcomed_at ? t('members.welcomed_yes') : t('members.welcomed_no')}
                        welcomed={!!member.welcomed_at}
                        announce={`${t('members.label_welcomed')}: ${member.welcomed_at ? t('members.welcomed_yes') : t('members.welcomed_no')}`}
                      />
                    </span>
                  )}
                  centers={{
                    defaultLabel: t('members.default_center'),
                    default: <p style={profileValueStyle}>{defaultCenter?.name ?? EMPTY_VALUE}</p>,
                  }}
                />
              </div>
            </Section>
          )}

          {/* #2422: effective center access, resolved by the server from the live plans. */}
          <Section label={t('members.section_center_access')} divider={!editing}>
            <div style={card}>
              <MemberCenterAccess memberId={memberId} refreshKey={centers} />
            </div>
          </Section>

          {/* Account (Clerk status) */}
          {(clerkStatus || (statuses && statuses.length > 0)) && (
            <Section label={t('members.section_account')} divider={!editing}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(statuses ?? []).map((st) => (
                  <div key={st.key} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <strong style={profileValueStyle}>{t(`members.${st.key}`)}:</strong>
                    {st.status ? <StatusBadge status={st.status} label={st.label} /> : <span style={profileValueStyle}>{st.label}</span>}
                  </div>
                ))}
              </div>
              {/* #1234: stored dates, independent of membership and payment.
                  #1326: the value is a chip; the date stays beside it as text. */}
              {clerkStatus && [
                ['label_clerk_status', clerkStatusLine(clerkStatus, locale, gymFmt), clerkStatus.enrolled ?? !!clerkStatus.clerk_user_id],
                ['label_clerk_invitation', clerkInvitationLine(clerkStatus, locale, gymFmt), !!clerkStatus.has_pending_invitation || clerkInvitationLine(clerkStatus, locale, gymFmt).key.startsWith('clerk_invitation_accepted')],
              ].map(([label, line, positive]) => {
                const l = line as ClerkAccountLine;
                const chipKey = l.key.replace(/_on$/, '');
                return (
                  <p key={label as string} style={profileValueStyle}>
                    <strong>{t(`members.${label as string}`)}:</strong>{' '}
                    <span style={{ ...(positive ? listNameBadgeAccentStyle : listNameBadgeStyle), fontSize: 13 }}>{t(`members.${chipKey}`)}</span>
                    {l.date ? <span> {l.date}</span> : null}
                  </p>
                );
              })}
              {clerkStatus && (
                <p style={profileValueStyle} data-testid="member-payment-token">
                  <strong>{t('members.label_payment_token')}:</strong>{' '}
                  <span style={{ ...(clerkStatus.has_payment_token ? listNameBadgeAccentStyle : listNameBadgeStyle), fontSize: 13 }}>
                    {t(clerkStatus.has_payment_token ? 'members.payment_token_available' : 'members.payment_token_unavailable')}
                  </span>
                </p>
              )}
            </Section>
          )}

        </>
      )}

      {tab === 'products_services' && (
        <>
          {/* #961 §2 — Products & Services: everything the Member bought or is
              billed for. The thread's Q2 answer put all four of the sections the
              ticket's own table left unassigned here, in the order the single
              column had them, and #1051 moved MEMBERSHIP PLANS in at the top of
              them. Which sections belong to which tab is `MEMBER_TABS` in
              memberTabs.ts, never this JSX.

              #634 §13 — the Member's Membership configuration as independent
              sections. Additional Products and the Billing Simulation are
              siblings of MEMBERSHIP PLANS, never nested inside a plan, and each
              one has its own editing controls.

              #931 — there is no PROMOTIONS section here. A Promotion belongs to the
              target it applies to (a Membership Plan or a Product), never to a
              Member, so it is configured from the Promotions page and applied with
              the Membership Plan the Member is assigned — which is what the Billing
              Simulation below already reflects. The applications an Assigned Plan
              was agreed with stay on the Assigned Plans card, from that
              application's own snapshot (#635 §16). */}

          {/* 1. MEMBERSHIP PLANS — the Member's assigned plans, Active and Past,
              drawn with the Assigned Plans page's own table (#1051). */}
          <ProductsWorkflowBar
            current={configuration.current_product_set}
            loading={productSetDetail.loading}
            error={productSetDetail.error}
            onDraftExpired={reloadProducts}
          />
          <Section label={t('members.section_membership_plan')} divider={false}>
            <span id="member-membership-plans-section" />
            <MemberMembershipPlans
              memberId={memberId}
              memberName={member.name}
              memberEmail={member.email ?? ''}
              plans={configuration.plans}
              productSets={configuration.product_sets}
              canWrite={isAdmin}
              onChanged={reloadConfiguration}
              onAssignNewPlan={setAssigningFor}
              onCancelPlan={setCancelling}
              onReactivatePlan={handleReactivatePlan}
              assignBusy={assigningFor !== null}
              renderAssignEditor={(m) => (
                // #628: Assign New Plan stays an explicit supersede action, edited
                // inline under the list it acts on — distinct from "+ Add
                // Membership Plan", which is purely additive.
                assigningFor?.id === m.id ? (
                  <AssignPlanInlineEditor
                    membership={{ id: m.id, plan_name: m.plan_name }}
                    plans={plans}
                    onCancel={() => setAssigningFor(null)}
                    onAssigned={() => { setAssigningFor(null); reloadConfiguration(); }}
                  />
                ) : null
              )}
            />
          </Section>

          {/* 2. The Recurring Products card is gone from this tab (#1613
              follow-up). The global Save & Pay still reviews a Draft through
              the Review modal; the recurring routes are untouched. */}
          <StandaloneCartPayModal
            memberId={memberId}
            open={cartPayOpen}
            onClose={() => setCartPayOpen(false)}
            onPaid={(url) => { void cartPaid(url); }}
          />
          {inFlightSetId != null && (
            <ReviewChangesModal
              productSetId={inFlightSetId}
              open={reviewOpen}
              onClose={() => setReviewOpen(false)}
              onCommitted={() => { setReviewOpen(false); setCommittedKey((k) => k + 1); reloadProducts(); }}
            />
          )}
          <Section label={t('members.section_additional_services')}>
            <span id="member-products-section" />

          {/* 3. PRODUCTS (#1521) — the Products this Member purchased, as one
              collapsible card: what they bought, under which price, tax and
              Promotion, and the payment that settled it. Read-only: a purchase
              is money that moved, and the Current Product Set and One-off
              Products cards that preceded it showed the ProductSet's
              configuration instead (#1463, #1490). The recurring services
              staff attach to an Assigned Plan are that plan's own section. */}
            <MemberPurchasedProducts
              items={purchasedProducts}
              memberId={memberId}
              canWrite={canWriteMembers}
              canPay={canManagePackages}
              isAdmin={isAdmin}
              onChanged={reloadProducts}
              committedKey={committedKey}
            />
          </Section>

          {/* #1613 — one billing section. While billing-affecting changes are
              pending (the server's review diff, a version awaiting payment or a
              pending one-off) it is the proposed configuration's simulation;
              the persisted ledger is on the Payments tab (#2099; #3241 removed it here). */}
          {billingSectionMode === 'simulation' && (
            <Section label={t('members.section_billing_event_simulation')}>
              <ProposedSetForecast productSetId={inFlightSetId} reloadKey={configuration} />
            </Section>
          )}


          {/* #1660 — Summary: the pending draft's additions and removals, last on
              the tab, with Save & Pay / Cancel directly beneath. */}
          {(inFlightSetsShown || saveAndPayTarget(workflow) === 'cart' || cartPaymentLink != null) && (
            <Section label={t('members.section_summary')}>
              {!inFlightSetsShown && (
                <StandaloneCartSummary memberId={memberId} reloadKey={purchasedProducts} paymentLink={cartPaymentLink} />
              )}
              <ProductSetsInFlight
                productSets={configuration.product_sets}
                canWrite={canWriteMembers && canManagePackages}
                review={draftReview}
                onChanged={reloadProducts}
              />
              <ProductsWorkflowActions
                current={configuration.current_product_set}
                workflow={workflow}
                canWrite={canWriteMembers && canManagePackages}
                // #3164 — cancelling the cart also re-reads the Products table, so the cancelled cart's
                // rows do not stay on screen as In Cart beside the restored Active ProductSet.
                onDiscarded={reloadProducts}
                busy={cartPayOpen}
                onSaveAndPay={() => {
                  const target = saveAndPayTarget(workflow);
                  if (target === 'review') setReviewOpen(true);
                  else if (target === 'cart') setCartPayOpen(true);
                  else if (target === 'purchases') document.getElementById('member-products-section')?.scrollIntoView({ behavior: 'smooth' });
                }}
              />
            </Section>
          )}

        </>
      )}

      {tab === 'bookings' && (
        <>
          {/* Bookings (#2720) — read-only: upcoming then past bookings of this Member. */}
          <Section label={t('members.section_bookings')} divider={false}>
            <MemberBookings memberId={memberId} />
          </Section>
        </>
      )}

      {tab === 'professional_services' && (
        <>
          {/* Professional Services (#1227) — the Member's balance per service,
              read from the same derived balance the booking gate uses. */}
          <Section label={t('members.section_professional_services')} divider={false}>
            <MemberProfessionalServices memberId={memberId} />
          </Section>

          {/* Personal Training Class Slots (#647 stages 2–3, moved here by #1461) — the Mon–Sun weekly
              availability grid, with slot selection and Book. The nightly rolling
              2-month window is stage 4. */}
          <Section label={t('members.section_pt_slots')}>
            <MemberPersonalTrainingSlots memberId={memberId} />
          </Section>
        </>
      )}

      {tab === 'nutrition' && (
        <>
          {/* Nutrition Plans */}
          <Section label={t('members.section_nutrition_plans')} divider={false}>
            {nutritionPlans.length === 0 ? (
              <>
                <p style={dim}>{t('members.no_nutrition_plans')}</p>
                {canManageNutrition && (
                  <button type="button" style={primaryBtnSmall()} onClick={() => setAssignNutritionOpen(true)}>
                    {t('members.assign_nutrition_plan')}
                  </button>
                )}
              </>
            ) : (
              <div>
                {(() => {
                  const renderNutrition = (plans: NutritionPlan[]) => (
                    <>
                {plans.map((p) => {
                  const open = nutritionExpanded.has(p.id);
                  const hierarchy = nutritionHierarchies[p.id];
                  const toggle = () => {
                    setNutritionExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                      return next;
                    });
                    if (!open && !hierarchy) {
                      apiFetch<Hierarchy>(`/member-nutrition-plans/${p.id}/hierarchy`)
                        .then((h) => setNutritionHierarchies((prev) => ({ ...prev, [p.id]: h })))
                        .catch(() => {});
                    }
                  };
                  return (
                  <div key={p.id} style={card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <button
                        type="button"
                        onClick={toggle}
                        aria-expanded={open}
                        style={{ all: 'unset', cursor: 'pointer', minWidth: 0, flex: 1, display: 'block' }}
                      >
                        <div style={{ fontWeight: 500, fontSize: 14 }}>
                          <span style={{ fontSize: 12, color: '#aaa', marginRight: 8 }}>{open ? '▼' : '▶'}</span>
                          {p.name}
                        </div>
                        {p.start_date && (
                          <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                            {formatGymDateOnly(p.start_date, gymFmt)}
                            {p.end_date ? ` → ${formatGymDateOnly(p.end_date, gymFmt)}` : ''}
                          </div>
                        )}
                        {p.status && (
                          <div style={{ marginTop: 4 }}>
                            <StatusBadge status={p.status} label={p.status} />
                          </div>
                        )}
                      </button>
                      {canManageNutrition && p.status !== 'completed' && (
                        <button
                          type="button"
                          style={primaryBtnSmall()}
                          onClick={() => router.push(`/${locale}/nutrition/nutrition-plans?member_id=${memberId}&open=${p.id}`)}
                        >
                          {t('members.edit')}
                        </button>
                      )}
                    </div>
                    {open && (
                      <div style={{ marginTop: 8 }}>
                        {hierarchy ? (
                          <NutritionPlanTree
                            templateId={p.id}
                            apiBase="/member-nutrition-plans"
                            hierarchy={hierarchy}
                            canWrite={false}
                            onChanged={() => {}}
                          />
                        ) : (
                          <p style={dim}>{t('nutrition_plans.loading')}</p>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
                    </>
                  );
                  const activeN = nutritionPlans.filter((p) => p.status === 'active');
                  const inactiveN = nutritionPlans.filter((p) => p.status !== 'active');
                  return (
                    <>
                      {activeN.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <div style={subLabelStyle}>{t('members.plans_active')}</div>
                          {renderNutrition(activeN)}
                        </div>
                      )}
                      {inactiveN.length > 0 && (
                        <div>
                          <InactiveToggle
                            label={t('members.plans_inactive')}
                            open={nutritionInactiveOpen}
                            onToggle={() => setNutritionInactiveOpen((o) => !o)}
                          />
                          {nutritionInactiveOpen && renderNutrition(inactiveN)}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </Section>
        </>
      )}

      <NewNutritionPlanDialog
        open={assignNutritionOpen}
        initialMemberId={Number(memberId)}
        onClose={() => setAssignNutritionOpen(false)}
        onCreated={() => {
          setAssignNutritionOpen(false);
          apiFetch<NutritionPlan[]>(`/member-nutrition-plans?member_id=${memberId}`)
            .then(setNutritionPlans)
            .catch(() => {});
        }}
      />

      {tab === 'personal_goals' && (
        <>
          {/* Personal Goals (#948 §4) — the goals this member holds. Goals *are*
              assigned on a Member directly, which is the opposite of #931's answer
              for Promotions and why this section carries its own controls; they all
              belong to Edit mode (#957), so the read-only view has none of them. */}
          <Section label={t('members.section_personal_goals')} divider={false}>
            <MemberPersonalGoals memberId={memberId} canWrite={canManagePersonalGoals} />
          </Section>
        </>
      )}

      {tab === 'training_plan' && (
        <>
          {/* Training Plans */}
          <Section label={t('members.section_training_plans')} divider={false}>
            {trainingPlans.length === 0 ? (
              <div>
                <p style={dim}>{t('members.no_training_plans')}</p>
                {canManageTraining && (
                  <button type="button" style={primaryBtnSmall()} onClick={() => setAssignTrainingOpen(true)}>
                    {t('members.assign_training_plan')}
                  </button>
                )}
              </div>
            ) : (
              <>
                {activePlans.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={subLabelStyle}>{t('members.plans_active')}</div>
                    {activePlans.map((p) => (
                      <PlanCard
                        key={p.id}
                        planId={p.training_plan_id}
                        name={p.training_plan_name}
                        status={p.status}
                        validFrom={p.valid_from}
                        validTo={p.valid_to}
                        onEdit={canManageTraining ? () => router.push(`/${locale}/training-plans?open=${p.training_plan_id}&member_id=${memberId}`) : undefined}
                        editLabel={t('members.edit')}
                      />
                    ))}
                  </div>
                )}
                {inactivePlans.length > 0 && (
                  <div>
                    <InactiveToggle
                      label={t('members.plans_inactive')}
                      open={trainingInactiveOpen}
                      onToggle={() => setTrainingInactiveOpen((o) => !o)}
                    />
                    {/* #2200: an inactive assignment is read-only — no Edit button. */}
                    {trainingInactiveOpen && inactivePlans.map((p) => (
                      <PlanCard
                        key={p.id}
                        planId={p.training_plan_id}
                        name={p.training_plan_name}
                        status={p.status}
                        validFrom={p.valid_from}
                        validTo={p.valid_to}
                        editLabel={t('members.edit')}
                        dim
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </Section>
          <NewTrainingPlanDialog
            open={assignTrainingOpen}
            presetMember={{ id: memberId, name: member.name }}
            onClose={() => setAssignTrainingOpen(false)}
            onCreated={() => { setAssignTrainingOpen(false); loadAll(); }}
          />
        </>
      )}

      {tab === 'progress' && (
        <>
          {/* Progress (#1231) — #1224's derived history for this Member; the readings
              can be edited (value and notes) or hard-deleted from their ⋮ menu. */}
          <Section label={t('members.section_progress')} divider={false}>
            <MemberProgress memberId={memberId} canWrite={canManageTraining} />
          </Section>
        </>
      )}

      {tab === 'family' && (
        <>
          {/* Family (#2123): who the Member's family is and who owns it; read-only unless MEMBERS write. */}
          <Section label={t('members.section_family')} divider={false}>
            <MemberFamily memberId={memberId} canWrite={canWriteMembers} />
          </Section>
        </>
      )}

      {tab === 'payments' && (
        <>
          {/* Payments (#2099) — read-only: actual billing events and their transactions. */}
          <Section label={t('members.section_payments')} divider={false}>
            <MemberPayments memberId={memberId} />
          </Section>
        </>
      )}

      {tab === 'purchases' && (
        <>
          {/* Purchases (#3273) — read-only: each checkout, what it contained and how it was paid. */}
          <Section label={t('members.section_purchases')} divider={false}>
            <MemberPurchases memberId={memberId} />
          </Section>
        </>
      )}

      <ConfirmDialog
        open={cancelling !== null}
        title={cancelling && cancelling.status !== 'in_cart' ? (cancelling.status === 'to_be_canceled' ? t('members.action_undo_cancel_plan') : t('members.cancel_plan_title')) : undefined}
        message={cancelling?.status === 'in_cart' ? t('members.confirm_remove_cart_plan')
          : cancelling?.status === 'to_be_canceled' ? t('members.confirm_undo_cancel_plan')
          : cancelling?.status === 'active' ? t('members.confirm_mark_cancel_plan')
          : cancelEndsOn ? t('members.confirm_cancel_plan_until', { date: formatGymDateOnly(cancelEndsOn, gymFmt) })
          : t('members.confirm_cancel_plan')}
        confirmLabel={cancelling?.status === 'in_cart' ? t('members.action_remove_cart_plan_confirm') : cancelling?.status === 'to_be_canceled' ? t('members.action_undo_cancel_plan') : t('members.action_cancel_plan')}
        cancelLabel={cancelling?.status === 'in_cart' ? t('members.action_remove_cart_plan_keep') : t('members.cancel_plan_go_back')}
        onConfirm={handleCancelPlan}
        onCancel={() => setCancelling(null)}
      />

    </div>
  );
}

/**
 * One section of the Member card: its header, then its contents.
 *
 * #929 §4 — the sections are separated by the card's own hairline rather than by
 * whitespace alone, and the first one carries none (`divider={false}`), so the
 * card reads as one structure instead of a stack of independent fields. The
 * header, the spacing and the rule are `formChrome`'s, shared with the Edit
 * form above and with every other card.
 */
function Section({ label, children, divider = true, hideLabel = false }: { label: string; children: React.ReactNode; divider?: boolean; hideLabel?: boolean }) {
  return (
    <div style={divider ? cardSectionDividedStyle : cardSectionStyle}>
      {/* #1521: a card that carries its own collapsible header names itself. */}
      {!hideLabel && <div style={cardSectionLabelStyle}>{label}</div>}
      {children}
    </div>
  );
}

function Field({ label, children, multiline }: { label: string; children: React.ReactNode; multiline?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: multiline ? 'flex-start' : 'center', fontSize: 14, marginBottom: 4 }}>
      <span style={{ ...cardMutedTextStyle, minWidth: 120, flexShrink: 0 }}>{label}</span>
      {/* #797: Notes is free text of any length — it wraps and keeps the author's
          line breaks instead of stretching the expanded card sideways. */}
      <span style={multiline ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 } : undefined}>
        {children}
      </span>
    </div>
  );
}

function PlanCard({
  planId, name, status, validFrom, validTo, onEdit, editLabel, dim: isDim,
}: {
  planId: number;
  name: string;
  status: string;
  validFrom: string | null;
  validTo: string | null;
  onEdit?: () => void;
  editLabel: string;
  dim?: boolean;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const gymFmt = useGymFormatSettings();
  // Expanding reads: the plan's tree is the Assigned Training Plans page's own
  // component with `canWrite` fixed to false, so no editing control exists here.
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<{ id: number; member_id: number; workouts?: Workout[] | null } | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);

  async function loadPlan() {
    setLoadingPlan(true);
    try { setPlan(await apiFetch(`/training-plans/${planId}`)); }
    catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
    finally { setLoadingPlan(false); }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) loadPlan();
  }

  return (
    <div style={{ ...card, opacity: isDim ? 0.75 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          style={{ all: 'unset', cursor: 'pointer', minWidth: 0, flex: 1, display: 'flex', gap: 8, alignItems: 'flex-start' }}
        >
          <span aria-hidden style={{ fontSize: 12, color: '#aaa', marginTop: 3 }}>{open ? '▼' : '▶'}</span>
          <span style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 14 }}>{name}</div>
            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <StatusBadge status={status} label={status} />
              {(validFrom || validTo) && (
                <span style={{ fontSize: 12, color: '#888' }}>
                  {validFrom ? formatGymDateOnly(validFrom, gymFmt) : ''}
                  {validFrom && validTo ? ' — ' : ''}
                  {validTo ? formatGymDateOnly(validTo, gymFmt) : ''}
                </span>
              )}
            </div>
          </span>
        </button>
        {onEdit && (
          <button type="button" onClick={onEdit} style={primaryBtnSmall()}>{editLabel}</button>
        )}
      </div>
      {open && (
        loadingPlan || !plan ? (
          <p style={{ color: '#888', fontSize: 14, margin: '10px 0 0' }}>{t('training_plans.loading')}</p>
        ) : (
          <PlanWorkoutTree plan={plan} canWrite={false} apiFetch={apiFetch} toast={toast} onChanged={() => {}} />
        )
      )}
    </div>
  );
}

/** #797: the empty-value convention of the Members screens (see the list columns). */
const EMPTY_VALUE = '\u2014';

// #929: the card's chrome is `components/formChrome.ts` — this file aliases the
// shared objects rather than restating them, so the Member card, the Edit form
// above it and every other card share one look. Only what is genuinely this
// card's own (the body inset) is declared here.
const panel: React.CSSProperties = { padding: '16px 24px' };
const dim = cardMutedTextStyle;
const card = innerCardStyle;
const subLabelStyle = cardSubLabelStyle;

/** Clickable header of a collapsed "Inactive" plan group (#1963). */
function InactiveToggle({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      style={{ ...subLabelStyle, display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
    >
      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      {label}
    </button>
  );
}
const fieldLabelStyle = formFieldLabelStyle;
const retryBtn = cardTextLinkStyle;
