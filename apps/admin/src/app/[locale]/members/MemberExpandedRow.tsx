'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { StatusBadge } from '@/components/StatusBadge';

interface UserMembership {
  id: number;
  status: string;
  membership_plan_id: number | null;
  plan_name: string | null;
  final_price: string | null;
  starts_at: string | null;
  ends_at: string | null;
  next_billing_date: string | null;
}

interface Allowance {
  id: number;
  activity_type_name: string;
  allowance_type: 'unlimited' | 'session_count';
  session_count: number | null;
  recurrence_interval: number | null;
  recurrence_unit: string | null;
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
  canManageTraining,
}: {
  memberId: number;
  canManageTraining: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const loadedRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [membership, setMembership] = useState<UserMembership | null>(null);
  const [membershipNotFound, setMembershipNotFound] = useState(false);
  const [allowances, setAllowances] = useState<Allowance[]>([]);

  const [clerkStatus, setClerkStatus] = useState<{ status: string } | null>(null);
  const [trainingPlans, setTrainingPlans] = useState<TrainingPlanAssignment[]>([]);
  const [nutritionPlans, setNutritionPlans] = useState<NutritionPlan[]>([]);
  const [billingEvents, setBillingEvents] = useState<BillingEvent[]>([]);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [memberships, plans, nutrition, events, clerk] = await Promise.all([
        apiFetch<UserMembership[]>(`/user-memberships?member_id=${memberId}`).catch(() => []),
        canManageTraining
          ? apiFetch<TrainingPlanAssignment[]>(`/members/${memberId}/member-training-plans`).catch(() => [])
          : Promise.resolve([]),
        apiFetch<NutritionPlan[]>(`/member-nutrition-plans?member_id=${memberId}`).catch(() => []),
        apiFetch<{ items: BillingEvent[] }>(`/billing-events/member/${memberId}?limit=50`).catch(() => ({ items: [] })),
        apiFetch<{ status: string }>(`/members/${memberId}/clerk-status`).catch(() => null),
      ]);

      const current = memberships[0] ?? null;
      setMembership(current);
      setMembershipNotFound(memberships.length === 0);
      setClerkStatus(clerk);
      setTrainingPlans(plans);
      setNutritionPlans(nutrition);
      setBillingEvents(events.items ?? []);

      if (current?.membership_plan_id) {
        apiFetch<Allowance[]>(`/membership-plans/${current.membership_plan_id}/allowances`)
          .then(setAllowances)
          .catch(() => setAllowances([]));
      }
    } catch {
      setError(t('members.expanded_error'));
    } finally {
      setLoading(false);
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

  return (
    <div style={panel}>
      {/* Account (Clerk status) */}
      {clerkStatus && (
        <Section label={t('members.section_account')}>
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
        </Section>
      )}

      {/* Membership */}
      <Section label={t('members.section_membership')}>
        {membershipNotFound ? (
          <p style={dim}>{t('members.no_membership')}</p>
        ) : !membership ? (
          <p style={dim}>{t('members.expanded_loading')}</p>
        ) : (
          <div style={card}>
            <Field label={t('members.membership_plan')}>{membership.plan_name ?? '—'}</Field>
            <Field label={t('members.membership_status')}>
              <StatusBadge status={membership.status} label={membership.status} />
            </Field>
            <Field label={t('members.membership_rate')}>
              {membership.final_price ? `€${parseFloat(membership.final_price).toFixed(2)}` : '—'}
            </Field>
            {membership.starts_at && (
              <Field label={t('members.membership_start')}>
                {fmtDate(membership.starts_at)}
              </Field>
            )}
            {membership.ends_at && (
              <Field label={t('members.membership_end')}>
                {fmtDate(membership.ends_at)}
              </Field>
            )}
            {membership.next_billing_date && (
              <Field label={t('members.membership_next_billing')}>
                {fmtDate(membership.next_billing_date)}
              </Field>
            )}

            {/* Benefits */}
            {membership.membership_plan_id != null && (
              <div style={{ marginTop: 10 }}>
                <div style={fieldLabelStyle}>{t('members.section_benefits')}</div>
                {allowances.length === 0 ? (
                  <p style={{ ...dim, margin: '2px 0 0' }}>{t('members.no_benefits')}</p>
                ) : (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13, color: '#444' }}>
                    {allowances.map((a) => (
                      <li key={a.id}>
                        {a.activity_type_name}
                        {a.allowance_type === 'session_count' && a.session_count != null
                          ? ` — ${a.session_count}${a.recurrence_interval ? ` / ${a.recurrence_interval} ${a.recurrence_unit}` : ''}`
                          : ' — Unlimited'}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Training Plans */}
      <Section label={t('members.section_training_plans')}>
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

      {/* Nutrition Plans */}
      <Section label={t('members.section_nutrition_plans')}>
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
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={sectionLabelStyle}>{label}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 4 }}>
      <span style={{ color: '#888', minWidth: 120, fontSize: 13 }}>{label}</span>
      <span>{children}</span>
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
    default: return type;
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const panel: React.CSSProperties = { padding: '16px 24px' };
const dim: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
const card: React.CSSProperties = {
  background: '#fff', border: '1px solid #e8e8ed', borderRadius: 6,
  padding: '10px 14px', marginBottom: 8,
};
const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase',
  letterSpacing: '0.07em', marginBottom: 8,
};
const subLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#aaa', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: 4,
};
const fieldLabelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 2 };
const editBtnStyle: React.CSSProperties = {
  background: 'none', border: '1px solid #d0d0d0', borderRadius: 4,
  padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: '#444', flexShrink: 0,
};
const retryBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#6c63ff', cursor: 'pointer',
  fontSize: 13, padding: 0, textDecoration: 'underline',
};
const eventRow: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 6,
  borderBottom: '1px solid #ebebef', paddingBottom: 8, marginBottom: 8,
};
const chevronBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', color: '#888',
  fontSize: 10, padding: '2px 4px', lineHeight: 1, flexShrink: 0, marginTop: 2,
};
const eventDetail: React.CSSProperties = {
  marginTop: 8, paddingTop: 8, borderTop: '1px solid #f0f0f0',
};
