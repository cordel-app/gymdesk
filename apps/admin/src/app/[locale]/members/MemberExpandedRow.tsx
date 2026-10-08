'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { StatusBadge } from '@/components/StatusBadge';
import { clerkStatusLine, clerkInvitationLine, type ClerkAccountFields, type ClerkAccountLine } from '@/lib/clerkAccountLines';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { primaryBtnSmall } from '@/components/ui';
import {
  cardHintStyle,
  cardMutedTextStyle,
  cardSectionDividedStyle,
  cardSectionLabelStyle,
  cardSectionStyle,
  cardSubLabelStyle,
  cardTextLinkStyle,
  formControlStyle,
  formFieldErrorStyle,
  formFieldLabelStyle,
  inlineActionsRowStyle,
  innerCardStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { AssignPlanInlineEditor } from './AssignPlanInlineEditor';
import { MemberBillingSimulation } from './MemberBillingSimulation';
import {
  MemberPurchasedProducts,
  type PurchasedProduct,
} from './MemberPurchasedProducts';
import { MemberPersonalTrainingSlots } from './MemberPersonalTrainingSlots';
import { MemberMembershipPlans } from './MemberMembershipPlans';
import { MemberAdditionalServices } from './MemberAdditionalServices';
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
import type { MemberTabId } from './memberTabs';

interface Plan {
  id: number;
  name: string;
}

interface TrainingPlanAssignment {
  id: number;
  training_plan_id: number;
  training_plan_name: string;
  status: 'active' | 'completed' | 'cancelled';
  valid_from: string | null;
  valid_to: string | null;
}

interface NutritionPlan {
  id: number;
  name: string;
  status: string;
}

interface SessionPackage {
  id: number;
  package_name: string;
  package_sessions: number;
  sessions_remaining: number;
  purchased_at: string;
  expires_at: string;
  status: 'active' | 'consumed' | 'expired' | 'cancelled';
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
}

export function MemberExpandedRow({
  memberId,
  member,
  tab,
  profileVersion,
  editing,
  canManageTraining,
  canManagePackages,
  canManagePersonalGoals,
  isAdmin,
  plans,
}: {
  memberId: number;
  /**
   * #797: the Member's persisted Profile, as the Members list read it. The
   * PROFILE section renders it read-only; it is deliberately the same row the
   * `⋮ → Edit` form is seeded from, so the two can never show different data.
   */
  member: MemberProfile;
  /**
   * #961: the work area on screen. Only this tab's sections are rendered —
   * which ones those are is `MEMBER_TABS` in `memberTabs.ts`, so a section is
   * never shown by two tabs and never by none. The page owns the state, so the
   * selected tab survives a save, an edit and the URL (`?member=&tab=`).
   */
  tab: MemberTabId;
  /** Bumped by the page when an edit was saved, so the centers below are re-read. */
  profileVersion: number;
  /**
   * #882: the inline Edit form is open above this row. It renders the Profile
   * itself, in this same layout, so the read-only PROFILE section below stands
   * down rather than showing the Member's Profile twice on one page.
   */
  editing: boolean;
  canManageTraining: boolean;
  canManagePackages: boolean;
  /**
   * #948 §4: write access to the PERSONAL GOALS section — NUTRITION, read
   * through `nutrition.personal_goals`'s own permission override (#1070), which
   * is what `/member-personal-goals` enforces.
   */
  canManagePersonalGoals: boolean;
  isAdmin: boolean;
  plans: Plan[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const loadedRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // #634 — the Member's Membership configuration: the Member's plans and their
  // additional services in one read, feeding two of the sections below.
  const [configuration, setConfiguration] = useState<MemberConfiguration>(EMPTY_CONFIGURATION);
  const [cancelling, setCancelling] = useState<MemberPlanRow | null>(null);
  const [assigningFor, setAssigningFor] = useState<MemberPlanRow | null>(null);
  // #629/#634 §12: the simulation must always reflect the current configuration,
  // so remounting it is how a change in either section above re-runs it.
  const [simulationKey, setSimulationKey] = useState(0);

  const [centers, setCenters] = useState<MemberCenter[]>([]);
  const [clerkStatus, setClerkStatus] = useState<({ status: string } & ClerkAccountFields) | null>(null);
  const [trainingPlans, setTrainingPlans] = useState<TrainingPlanAssignment[]>([]);
  const [nutritionPlans, setNutritionPlans] = useState<NutritionPlan[]>([]);
  const [billingEvents, setBillingEvents] = useState<BillingEvent[]>([]);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<number>>(new Set());
  const [sessionPackages, setSessionPackages] = useState<SessionPackage[]>([]);
  // #1118 §12 — the Products this Member bought from the Members App, each with
  // the Promotion snapshot it was bought under.
  const [purchasedProducts, setPurchasedProducts] = useState<PurchasedProduct[]>([]);
  const [extendingId, setExtendingId] = useState<number | null>(null);
  const [extendValue, setExtendValue] = useState('');
  const [extendSaving, setExtendSaving] = useState(false);
  const [extendError, setExtendError] = useState<string | null>(null);

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

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [
        config, memberTrainingPlans, nutrition, events, clerk, packages, memberCenters, purchases,
      ] = await Promise.all([
        apiFetch<MemberConfiguration>(`/user-memberships/member/${memberId}/configuration`)
          .catch(() => EMPTY_CONFIGURATION),
        canManageTraining
          ? apiFetch<TrainingPlanAssignment[]>(`/members/${memberId}/member-training-plans`).catch(() => [])
          : Promise.resolve([]),
        apiFetch<NutritionPlan[]>(`/member-nutrition-plans?member_id=${memberId}`).catch(() => []),
        apiFetch<{ items: BillingEvent[] }>(`/billing-events/member/${memberId}?limit=50`).catch(() => ({ items: [] })),
        apiFetch<{ status: string } & ClerkAccountFields>(`/members/${memberId}/clerk-status`).catch(() => null),
        apiFetch<SessionPackage[]>(`/members/${memberId}/class-packages`).catch(() => []),
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
      setSessionPackages(packages);
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

  // #634 §12: every change in the MEMBERSHIP PLANS or ADDITIONAL PRODUCTS
  // sections lands here — it re-reads the configuration both are rendered from
  // and remounts the Billing Simulation, so the simulation always
  // shows the Member's current complete configuration. The other expanded-row
  // sections (training plans, packages, billing events) are left alone.
  async function reloadConfiguration() {
    try {
      setConfiguration(await apiFetch<MemberConfiguration>(`/user-memberships/member/${memberId}/configuration`));
      setSimulationKey((k) => k + 1);
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'));
    }
  }

  async function handleCancelPlan() {
    if (!cancelling) return;
    try {
      await apiFetch(`/user-memberships/${cancelling.id}`, { method: 'DELETE' });
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

  function startExtend(pkg: SessionPackage) {
    setExtendingId(pkg.id);
    setExtendValue(pkg.expires_at.slice(0, 10));
    setExtendError(null);
  }

  function cancelExtend() {
    setExtendingId(null);
    setExtendValue('');
    setExtendError(null);
  }

  async function saveExtend(pkg: SessionPackage) {
    if (!extendValue) return;
    setExtendSaving(true);
    setExtendError(null);
    try {
      const updated = await apiFetch<SessionPackage>(
        `/members/${memberId}/class-packages/${pkg.id}/extend-expiration`,
        { method: 'PUT', body: JSON.stringify({ expires_at: extendValue }) },
      );
      setSessionPackages((prev) => prev.map((p) => (p.id === pkg.id ? updated : p)));
      setExtendingId(null);
      setExtendValue('');
    } catch (err: any) {
      setExtendError(err?.status === 400 ? t('members.extend_expiration_error') : t('members.extend_expiration_generic_error'));
    } finally {
      setExtendSaving(false);
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
              <div style={card}>
                <MemberProfileLayout
                  fieldLabel={(f) => t(`members.${f.labelKey}`)}
                  renderField={(f) => (
                    <p style={profileValueStyle}>
                      {(f.kind === 'date'
                        ? formatProfileDate(member[f.key])
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
              </div>
            </Section>
          )}

          {/* Account (Clerk status) */}
          {clerkStatus && (
            <Section label={t('members.section_account')} divider={!editing}>
              <StatusBadge
                status={clerkStatus.status}
                label={
                  clerkStatus.status === 'not_enrolled' ? t('members.clerk_not_enrolled')
                  : clerkStatus.status === 'invited' ? t('members.clerk_invited')
                  : clerkStatus.status === 'active' ? t('members.clerk_active')
                  : clerkStatus.status === 'suspended' ? t('members.clerk_suspended')
                  : t('members.clerk_error')
                }
              />
              {/* #1234: stored dates, independent of membership and payment. */}
              {[
                ['label_clerk_status', clerkStatusLine(clerkStatus, locale)],
                ['label_clerk_invitation', clerkInvitationLine(clerkStatus, locale)],
              ].map(([label, line]) => (
                <p key={label as string} style={profileValueStyle}>
                  <strong>{t(`members.${label as string}`)}:</strong>{' '}
                  {t(`members.${(line as ClerkAccountLine).key}`, { date: (line as ClerkAccountLine).date ?? '' })}
                </p>
              ))}
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
          <Section label={t('members.section_membership_plans')} divider={false}>
            <MemberMembershipPlans
              memberId={memberId}
              plans={configuration.plans}
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

          {/* 2. PRODUCTS & SERVICES (#1118 §11, renamed from *Additional
              Products*) — the Admin representation of everything the Member
              holds beside their plan: the Products they bought from the Members
              App (§12, read-only — a purchase is money that moved) and the
              recurring Products staff attach to an Assigned Plan, which are
              independent from plans and promotions (#634 §4). #957: the section
              reads in both modes; the services editor's `+ Add Product` button
              is Edit mode's alone. */}
          <Section label={t('members.section_additional_services')}>
            <div style={{ marginBottom: 14 }}>
              <div style={subLabelStyle}>{t('members.purchased_products_label')}</div>
              <MemberPurchasedProducts items={purchasedProducts} />
            </div>
            <div style={subLabelStyle}>{t('members.periodic_services_label')}</div>
            <MemberAdditionalServices
              plans={configuration.plans}
              services={configuration.services}
              canWrite={isAdmin}
              editing={editing}
              onChanged={reloadConfiguration}
            />
          </Section>

          {/* Billing Simulation (#629) — a section of its own, never nested inside
              a Membership Plan card (#634 §13). Read-only: it persists nothing. */}
          <Section label={t('members.section_billing_simulation')}>
            <MemberBillingSimulation key={simulationKey} memberId={memberId} />
          </Section>

          {/* Personal Training Class Slots (#647 stages 2–3) — the Mon–Sun weekly
              availability grid, with slot selection and Book. The nightly rolling
              2-month window is stage 4. */}
          <Section label={t('members.section_pt_slots')}>
            <MemberPersonalTrainingSlots memberId={memberId} />
          </Section>

          {/* Session Packages */}
          <Section label={t('members.section_session_packages')}>
            {sessionPackages.length === 0 ? (
              <p style={dim}>{t('members.no_session_packages')}</p>
            ) : (
              <div>
                {sessionPackages.map((pkg) => {
                  const used = pkg.package_sessions - pkg.sessions_remaining;
                  const isExpired = pkg.status === 'expired';
                  return (
                    <div key={pkg.id} style={card}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 500, fontSize: 14 }}>{pkg.package_name}</div>
                          <Field label={t('members.package_purchased')}>{fmtDate(pkg.purchased_at)}</Field>
                          <Field label={t('members.package_sessions_total')}>{pkg.package_sessions}</Field>
                          <Field label={t('members.package_sessions_used')}>{used}</Field>
                          <Field label={t('members.package_sessions_remaining')}>{pkg.sessions_remaining}</Field>
                          <Field label={isExpired ? t('members.package_expired_label') : t('members.package_expires')}>
                            {fmtDate(pkg.expires_at)}
                          </Field>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                          <StatusBadge status={pkg.status} label={pkg.status} />
                          {canManagePackages && extendingId !== pkg.id && (
                            <button onClick={() => startExtend(pkg)} style={editBtnStyle}>{t('members.extend_expiration')}</button>
                          )}
                        </div>
                      </div>
                      {extendingId === pkg.id && (
                        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--gd-card-border, #e8e8ed)' }}>
                          <div style={fieldLabelStyle}>{t('members.extend_expiration_title')}</div>
                          <Field label={t('members.extend_expiration_current')}>{fmtDate(pkg.expires_at)}</Field>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                            <span style={{ ...cardHintStyle, margin: 0, minWidth: 120 }}>{t('members.extend_expiration_new')}</span>
                            <input
                              type="date"
                              value={extendValue}
                              onChange={(e) => setExtendValue(e.target.value)}
                              style={{ ...formControlStyle, width: 'auto' }}
                            />
                          </div>
                          {extendError && <p style={formFieldErrorStyle}>{extendError}</p>}
                          {/* The section's own Save is a primary action and takes the
                              Theme's primary-button colours (#912), not a black box. */}
                          <div style={inlineActionsRowStyle}>
                            <button onClick={cancelExtend} disabled={extendSaving} style={secondaryBtnSmall}>{t('members.cancel')}</button>
                            <button
                              onClick={() => saveExtend(pkg)}
                              disabled={extendSaving || !extendValue}
                              style={primaryBtnSmall()}
                            >
                              {extendSaving ? t('members.saving') : t('members.save_changes')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* Billing Events */}
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
                          <span style={{ fontSize: 12, color: '#888', whiteSpace: 'nowrap' }}>{fmtDate(ev.created_at)}</span>
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

      {tab === 'nutrition' && (
        <>
          {/* Nutrition Plans */}
          <Section label={t('members.section_nutrition_plans')} divider={false}>
            {nutritionPlans.length === 0 ? (
              <p style={dim}>{t('members.no_nutrition_plans')}</p>
            ) : (
              <div>
                {nutritionPlans.map((p) => (
                  <div key={p.id} style={card}>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>{p.name}</div>
                    {p.status && (
                      <div style={{ marginTop: 4 }}>
                        <StatusBadge status={p.status} label={p.status} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      {tab === 'personal_goals' && (
        <>
          {/* Personal Goals (#948 §4) — the goals this member holds. Goals *are*
              assigned on a Member directly, which is the opposite of #931's answer
              for Promotions and why this section carries its own controls; they all
              belong to Edit mode (#957), so the read-only view has none of them. */}
          <Section label={t('members.section_personal_goals')} divider={false}>
            <MemberPersonalGoals memberId={memberId} canWrite={canManagePersonalGoals} editing={editing} />
          </Section>
        </>
      )}

      {tab === 'training_plan' && (
        <>
          {/* Training Plans */}
          <Section label={t('members.section_training_plans')} divider={false}>
            {trainingPlans.length === 0 ? (
              <p style={dim}>{t('members.no_training_plans')}</p>
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
                    <div style={subLabelStyle}>{t('members.plans_inactive')}</div>
                    {inactivePlans.map((p) => (
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
        </>
      )}

      <ConfirmDialog
        open={cancelling !== null}
        message={t('members.confirm_cancel_plan')}
        confirmLabel={t('members.action_cancel_plan')}
        cancelLabel={t('members.cancel')}
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
function Section({ label, children, divider = true }: { label: string; children: React.ReactNode; divider?: boolean }) {
  return (
    <div style={divider ? cardSectionDividedStyle : cardSectionStyle}>
      <div style={cardSectionLabelStyle}>{label}</div>
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
  return (
    <div style={{ ...card, opacity: isDim ? 0.75 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 500, fontSize: 14 }}>{name}</div>
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <StatusBadge status={status} label={status} />
            {(validFrom || validTo) && (
              <span style={{ fontSize: 12, color: '#888' }}>
                {validFrom ? fmtDate(validFrom) : ''}
                {validFrom && validTo ? ' — ' : ''}
                {validTo ? fmtDate(validTo) : ''}
              </span>
            )}
          </div>
        </div>
        {onEdit && (
          <button onClick={onEdit} style={editBtnStyle}>{editLabel}</button>
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

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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
const fieldLabelStyle = formFieldLabelStyle;
const editBtnStyle: React.CSSProperties = { ...secondaryBtnSmall, flexShrink: 0 };
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
