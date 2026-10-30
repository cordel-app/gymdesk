'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { listNameBadgeStyle, listNameBadgeAccentStyle } from '@/components/listChrome';
import { StatusBadge } from '@/components/StatusBadge';
import { formatGymDate, formatGymDateOnly } from '@/lib/gymFormat';
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
import { ProductsWorkflowBar, useDraftReview } from './MemberProductsWorkflow';
import { billingMode, pendingOneOffCount, saveAndPayTarget } from './productsWorkflowView';
import { ReviewChangesModal } from './ReviewChangesModal';
import { MemberProgress } from './MemberProgress';
import { MemberPayments } from './MemberPayments';
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
import { MemberProfileLayout, NewMemberValue, profileValueStyle } from './MemberProfileLayout';
import { MemberImagePreview, memberImagePreviewSrc } from '@/components/MemberImageField';
import type { MemberTabId } from './memberTabs';
import { MemberProfessionalServices } from './MemberProfessionalServices';
import { NewTrainingPlanDialog } from '../training-plans/NewTrainingPlanDialog';

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

interface BillingEvent {
  id: number;
  event_type: string;
  previous_status: string | null;
  new_status: string | null;
  charge_type_code: string | null;
  amount: string | null;
  notes: string | null;
  source: string;
  created_at: string;
  receipt_number: string | null;
  /** The date the event is due (a ProductSet event's own billing date). A
   * Scheduled obligation is created today for a later cycle, so its creation
   * date would list next month's charge beside today's payment. */
  billing_date?: string | null;
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

  const [billingEvents, setBillingEvents] = useState<BillingEvent[]>([]);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<number>>(new Set());
  // #1118 §12 — the Products this Member bought from the Members App, each with
  // the Promotion snapshot it was bought under.
  const [purchasedProducts, setPurchasedProducts] = useState<PurchasedProduct[]>([]);
  // #1537: the Draft is the member's own in-flight version (created on first use).
  // #1613 — the in-flight version (Draft or awaiting payment) whose simulation is shown.
  const inFlightSetId = ['draft', 'pending_payment'].includes(configuration.current_product_set?.status ?? '') && !configuration.current_product_set?.expired
    ? configuration.current_product_set!.id : null;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [committedKey, setCommittedKey] = useState(0);
  const draftReview = useDraftReview(configuration.current_product_set, configuration);
  const workflow = {
    current: configuration.current_product_set,
    review: draftReview,
    pendingOneOffs: pendingOneOffCount(purchasedProducts),
  };
  const billingSectionMode = billingMode(workflow);

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
        config, memberTrainingPlans, nutrition, events, clerk, memberCenters, purchases,
      ] = await Promise.all([
        apiFetch<MemberConfiguration>(`/user-memberships/member/${memberId}/configuration`)
          .catch(() => EMPTY_CONFIGURATION),
        canManageTraining
          ? apiFetch<TrainingPlanAssignment[]>(`/members/${memberId}/member-training-plans`).catch(() => [])
          : Promise.resolve([]),
        apiFetch<NutritionPlan[]>(`/member-nutrition-plans?member_id=${memberId}`).catch(() => []),
        apiFetch<{ items: BillingEvent[] }>(`/billing-events/member/${memberId}?limit=50`).catch(() => ({ items: [] })),
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
      setBillingEvents(events.items ?? []);
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
      const isDraft = cancelling.status === 'draft';
      await apiFetch(`/user-memberships/${cancelling.id}${isDraft ? '/draft' : ''}`, { method: 'DELETE' });
      setCancelling(null);
      reloadConfiguration();
    } catch (err: any) {
      setCancelling(null);
      toast(err.message ?? t('members.error_generic'));
    }
  }

  function toggleEvent(id: number) {
    setExpandedEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
                    <NewMemberValue
                      isNewMember={member.is_new_member}
                      label={t(`members.${newMemberValueKey(member.is_new_member)}`)}
                      announce={t(`members.${newMemberAnnounceKey(member.is_new_member)}`)}
                    />
                  )}
                  centers={{
                    assignedLabel: t('members.assigned_centers'),
                    assigned: (
                      <p style={profileValueStyle}>
                        {centers.length === 0 ? EMPTY_VALUE : centers.map((c) => c.name).join('\n')}
                      </p>
                    ),
                    defaultLabel: t('members.default_center'),
                    default: <p style={profileValueStyle}>{defaultCenter?.name ?? EMPTY_VALUE}</p>,
                  }}
                />
                <p style={{ ...profileValueStyle, marginTop: 12 }} data-testid="member-welcomed">
                  {t('members.label_welcomed')}: {member.welcomed_at ? t('members.welcomed_yes') : t('members.welcomed_no')}
                </p>
              </div>
            </Section>
          )}

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
                    <span style={positive ? listNameBadgeAccentStyle : listNameBadgeStyle}>{t(`members.${chipKey}`)}</span>
                    {l.date ? <span> {l.date}</span> : null}
                  </p>
                );
              })}
              {clerkStatus && (
                <p style={profileValueStyle} data-testid="member-payment-token">
                  <strong>{t('members.label_payment_token')}:</strong>{' '}
                  <span style={clerkStatus.has_payment_token ? listNameBadgeAccentStyle : listNameBadgeStyle}>
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
            workflow={workflow}
            canWrite={canWriteMembers && canManagePackages}
            onDiscarded={reloadConfiguration}
            onSaveAndPay={() => {
              const target = saveAndPayTarget(workflow);
              if (target === 'review') setReviewOpen(true);
              else if (target === 'purchases') document.getElementById('member-products-section')?.scrollIntoView({ behavior: 'smooth' });
            }}
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
              the ledger is the separate Actual Billing Events section at the foot of the tab (#1867). */}
          {billingSectionMode === 'simulation' && (
            <Section label={t('members.section_billing_event_simulation')}>
              <ProposedSetForecast productSetId={inFlightSetId} reloadKey={configuration} />
            </Section>
          )}


          {/* #1660 — Summary: the pending draft's additions and removals, last on
              the tab, with Save & Pay / Cancel directly beneath. */}
          {(configuration.product_sets ?? []).some((p: any) => p.status === 'draft' || p.status === 'pending_payment') && (
            <Section label={t('members.section_summary')}>
              <ProductSetsInFlight
                productSets={configuration.product_sets}
                canWrite={canWriteMembers && canManagePackages}
                changes={draftReview?.changes}
                onChanged={reloadConfiguration}
              />
            </Section>
          )}

          {/* #1867 — Actual Billing Events: the real ledger, always shown and
              last on the tab, strictly separate from the simulation above. */}
          <Section label={t('members.section_billing_events')}>
            {billingEvents.length === 0 ? (
              <p style={dim}>{t('members.no_billing_events')}</p>
            ) : (
              <div>
                {billingEvents.map((ev) => {
                  const isExpanded = expandedEventIds.has(ev.id);
                  return (
                    <div key={ev.id} style={eventRow}>
                      <button
                        onClick={() => toggleEvent(ev.id)}
                        aria-expanded={isExpanded}
                        aria-label={isExpanded ? 'Collapse event' : 'Expand event'}
                        style={chevronBtn}
                      >
                        <span style={{ display: 'inline-block', transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
                      </button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', flexWrap: 'wrap' }}
                          onClick={() => toggleEvent(ev.id)}
                        >
                          <span style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>{ev.billing_date ? formatGymDateOnly(ev.billing_date, gymFmt) : formatGymDate(ev.created_at, gymFmt)}</span>
                          <span style={{ fontSize: 13, flex: 1 }}>{eventTypeLabel(ev.event_type, t)}</span>
                          {ev.amount && (
                            <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                              €{parseFloat(ev.amount).toFixed(2)}
                            </span>
                          )}
                        </div>
                        {isExpanded && (
                          <div style={eventDetail}>
                            {ev.event_type === 'status_changed' ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span style={{ color: '#888', fontSize: 12 }}>{t('members.event_status_changed')}:</span>
                                <StatusBadge status={ev.previous_status ?? 'inactive'} label={ev.previous_status ?? '—'} />
                                <span style={{ color: '#888' }}>→</span>
                                <StatusBadge status={ev.new_status ?? 'inactive'} label={ev.new_status ?? '—'} />
                              </div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
                                {ev.charge_type_code && (
                                  <span><span style={{ color: '#888' }}>{t('members.event_type_label')}:</span> {ev.charge_type_code}</span>
                                )}
                                {ev.notes && (
                                  <span><span style={{ color: '#888' }}>{t('members.event_notes')}:</span> {ev.notes}</span>
                                )}
                                {ev.source && (
                                  <span><span style={{ color: '#888' }}>{t('members.event_source')}:</span> {ev.source}</span>
                                )}
                                {ev.receipt_number && (
                                  <span><span style={{ color: '#888' }}>{t('members.event_receipt')}:</span> {ev.receipt_number}</span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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
                      {canManageNutrition && (
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
                    {trainingInactiveOpen && inactivePlans.map((p) => (
                      <PlanCard
                        key={p.id}
                        name={p.training_plan_name}
                        status={p.status}
                        validFrom={p.valid_from}
                        validTo={p.valid_to}
                        onEdit={canManageTraining ? () => router.push(`/${locale}/training-plans?open=${p.training_plan_id}&member_id=${memberId}`) : undefined}
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

      <ConfirmDialog
        open={cancelling !== null}
        message={cancelling?.status === 'draft' ? t('members.confirm_discard_draft') : t('members.confirm_cancel_plan')}
        confirmLabel={cancelling?.status === 'draft' ? t('members.action_discard_draft_confirm') : t('members.action_cancel_plan')}
        cancelLabel={cancelling?.status === 'draft' ? t('members.action_discard_draft_dismiss') : t('members.cancel')}
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
  name, status, validFrom, validTo, onEdit, editLabel, dim: isDim,
}: {
  name: string;
  status: string;
  validFrom: string | null;
  validTo: string | null;
  onEdit?: () => void;
  editLabel: string;
  dim?: boolean;
}) {
  const gymFmt = useGymFormatSettings();
  return (
    <div style={{ ...card, opacity: isDim ? 0.75 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
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
        </div>
        {onEdit && (
          <button type="button" onClick={onEdit} style={primaryBtnSmall()}>{editLabel}</button>
        )}
      </div>
    </div>
  );
}

function eventTypeLabel(type: string, t: ReturnType<typeof useTranslations>): string {
  switch (type) {
    case 'charge_created': return t('members.event_charge_created');
    case 'payment_recorded': return t('members.event_payment_recorded');
    case 'adjustment': return t('members.event_adjustment');
    case 'status_changed': return t('members.event_status_changed_label');
    // #635 stage 11 — a cycle the assignment's Free Period, Bonus Duration or
    // an applied Promotion covered: recorded at €0, never charged.
    case 'waived_billing': return t('members.event_waived_billing');
    default: return type;
  }
}

/** #797: the empty-value convention of the Members screens (see the list columns). */
const EMPTY_VALUE = '\u2014';

// #929: the card's chrome is `components/formChrome.ts` — this file aliases the
// shared objects rather than restating them, so the Member card, the Edit form
// above it and every other card share one look. Only what is genuinely this
// card's own (the body inset, the Billing Events ledger rows) is declared here.
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
const eventRow: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 6,
  borderBottom: '1px solid var(--gd-card-border, #e8e8ed)', paddingBottom: 8, marginBottom: 8,
};
const chevronBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', color: '#888',
  fontSize: 10, padding: '2px 4px', lineHeight: 1, flexShrink: 0, marginTop: 2,
};
const eventDetail: React.CSSProperties = {
  marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--gd-card-border, #e8e8ed)',
};
