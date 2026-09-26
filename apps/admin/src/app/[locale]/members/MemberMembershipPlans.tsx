'use client';

// #634 §1/§2 — MEMBERSHIP PLANS, the first of the Member's four independent
// Membership sections.
//
// It manages nothing but the Member's Membership Plans: Promotions, Additional
// Services and the Billing Simulation are siblings of this section, never
// nested inside a plan card (§13). Adding a plan is additive — it never closes,
// cancels or replaces an existing one (§14) — because a Member may hold several
// active plans at once (§6, one per Plan; migration 172). Superseding a plan is
// still available as the explicit "Assign New Plan" action on the plan itself.
//
// Inline throughout (§15): "+ Add Membership Plan" opens a draft below the
// list, saved or discarded in place. No modal, no wizard, no separate page.

import React, { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import type { MemberPlanRow } from './membershipConfiguration';

interface AssignablePlan {
  id: number;
  name: string;
}

interface Props {
  memberId: number;
  plans: MemberPlanRow[];
  canWrite: boolean;
  /** Re-reads the Member's configuration and re-runs the Billing Simulation (§12). */
  onChanged: () => void;
  onAssignNewPlan: (plan: MemberPlanRow) => void;
  onCancelPlan: (plan: MemberPlanRow) => void;
  /** The inline "Assign New Plan" editor for a plan, rendered inside its card (#628). */
  renderAssignEditor: (plan: MemberPlanRow) => React.ReactNode;
  assignBusy: boolean;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * DD/MM/YYYY from the plain YYYY-MM-DD the configuration endpoint returns,
 * without going through `Date` — parsing a bare date as UTC midnight and then
 * formatting it locally shows the previous day west of Greenwich. Same helper
 * shape as `fmtDay` in MemberBillingSimulation.tsx.
 */
function fmtDate(date: string): string {
  const [y, m, d] = date.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export function MemberMembershipPlans({
  memberId, plans, canWrite, onChanged, onAssignNewPlan, onCancelPlan, renderAssignEditor, assignBusy,
}: Props) {
  const t = useTranslations('members');
  // `status.*` lives at the root of the message catalogue, not under `members`.
  const tStatus = useTranslations('status');
  const { apiFetch } = useApiClient();
  const optionsLoadedRef = useRef(false);

  const [adding, setAdding] = useState(false);
  const [options, setOptions] = useState<AssignablePlan[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [draftPlanId, setDraftPlanId] = useState<number | null>(null);
  const [draftStartsAt, setDraftStartsAt] = useState(todayISO());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // §2: only Active + Public Membership Plans may be offered. The server
  // enforces the same rule on assignment, so this filter only keeps the picker
  // from offering something the API would refuse.
  useEffect(() => {
    if (!adding || optionsLoadedRef.current) return;
    optionsLoadedRef.current = true;
    setOptionsLoading(true);
    apiFetch<AssignablePlan[]>('/membership-plans?lifecycle_status=active&enrollment_status=public')
      .then(setOptions)
      .catch(() => setOptions([]))
      .finally(() => setOptionsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding]);

  const live = plans.filter((p) => p.is_live);
  const history = plans.filter((p) => !p.is_live);
  // §14: a Plan already active for this Member can't be assigned again (the
  // unique index would reject it), so it is left out of the picker.
  const activePlanIds = new Set(live.map((p) => p.membership_plan_id).filter((id): id is number => id != null));
  const selectable = options.filter((o) => !activePlanIds.has(o.id));

  function startAdding() {
    setAdding(true);
    setDraftPlanId(null);
    setDraftStartsAt(todayISO());
    setError(null);
  }

  function cancelAdding() {
    setAdding(false);
    setDraftPlanId(null);
    setError(null);
  }

  async function save() {
    if (draftPlanId == null) { setError(t('add_membership_plan_error_no_plan')); return; }
    if (!draftStartsAt) { setError(t('assign_new_plan_error_no_start')); return; }
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/user-memberships', {
        method: 'POST',
        body: JSON.stringify({
          member_id: memberId,
          membership_plan_id: draftPlanId,
          starts_at: draftStartsAt,
        }),
      });
      setAdding(false);
      setDraftPlanId(null);
      onChanged();
    } catch (err: any) {
      setError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {live.length === 0 ? (
        <p style={dim}>{t('no_active_membership_plans')}</p>
      ) : (
        live.map((m) => (
          <PlanCard
            key={m.id}
            plan={m}
            canWrite={canWrite}
            assignBusy={assignBusy}
            onAssignNewPlan={onAssignNewPlan}
            onCancelPlan={onCancelPlan}
            t={t}
            statusLabel={(s) => tStatus(s as never)}
          >
            {renderAssignEditor(m)}
          </PlanCard>
        ))
      )}

      {canWrite && !adding && (
        <button onClick={startAdding} style={addBtn}>{t('add_membership_plan')}</button>
      )}

      {adding && (
        <div style={editorStyle}>
          <div style={editorTitle}>{t('add_membership_plan_title')}</div>

          <div style={labelStyle}>{t('assign_new_plan_label_plan')}</div>
          {optionsLoading ? (
            <p style={hint}>{t('add_membership_plan_loading')}</p>
          ) : selectable.length === 0 ? (
            <p style={hint}>{t('add_membership_plan_none')}</p>
          ) : (
            // §2: one Membership Plan per assignment, picked with radio buttons.
            <div role="radiogroup" aria-label={t('assign_new_plan_label_plan')} style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 12px' }}>
              {selectable.map((o) => (
                <label key={o.id} style={optionRow(draftPlanId === o.id)}>
                  <input
                    type="radio"
                    name={`add-plan-${memberId}`}
                    checked={draftPlanId === o.id}
                    disabled={saving}
                    onChange={() => setDraftPlanId(o.id)}
                    style={{ marginRight: 8 }}
                  />
                  <span>{o.name}</span>
                </label>
              ))}
            </div>
          )}

          <div style={labelStyle}>{t('assign_new_plan_label_starts')}</div>
          <input
            type="date"
            value={draftStartsAt}
            onChange={(e) => setDraftStartsAt(e.target.value)}
            disabled={saving}
            style={inputStyle}
          />

          {error && <p style={errorStyle}>{error}</p>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={saving || selectable.length === 0} style={saveBtn}>
              {saving ? t('saving') : t('add_membership_plan_submit')}
            </button>
            <button onClick={cancelAdding} disabled={saving} style={cancelBtn}>{t('cancel')}</button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={subLabel}>{t('membership_plans_history')}</div>
          {history.map((m) => (
            <PlanCard key={m.id} plan={m} canWrite={false} assignBusy={assignBusy} t={t} statusLabel={(s) => tStatus(s as never)} dimmed />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanCard({
  plan, canWrite, assignBusy, onAssignNewPlan, onCancelPlan, t, statusLabel, dimmed, children,
}: {
  plan: MemberPlanRow;
  canWrite: boolean;
  assignBusy: boolean;
  onAssignNewPlan?: (plan: MemberPlanRow) => void;
  onCancelPlan?: (plan: MemberPlanRow) => void;
  t: ReturnType<typeof useTranslations>;
  statusLabel: (status: string) => string;
  dimmed?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ ...card, opacity: dimmed ? 0.75 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 14 }}>{plan.plan_name ?? '—'}</div>
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <StatusBadge status={plan.status} label={statusLabel(plan.status)} />
            <span style={{ fontSize: 13 }}>
              {plan.membership_fee != null ? `€${plan.membership_fee.toFixed(2)}` : '—'}
            </span>
          </div>
          {plan.starts_at && <Field label={t('membership_start')}>{fmtDate(plan.starts_at)}</Field>}
          {plan.ends_at && <Field label={t('membership_end')}>{fmtDate(plan.ends_at)}</Field>}
          {plan.is_live && plan.next_billing_date && (
            <Field label={t('membership_next_billing')}>{fmtDate(plan.next_billing_date)}</Field>
          )}
          {/* #635 stage 4: the card listed the Plan's Included Services here
              (#511/#634) until the concept was retired (migration 177). Which
              activities the Member may book is the Activity Type's own
              eligible-plan list now, edited from the Activity Types page. */}
        </div>
        {canWrite && onAssignNewPlan && onCancelPlan && (
          <ContextMenu
            ariaLabel={`Actions for ${plan.plan_name ?? 'plan'}`}
            items={[
              {
                label: t('action_assign_new_plan'),
                onClick: () => onAssignNewPlan(plan),
                // #628: only one inline assignment editor at a time — they
                // share a single draft state.
                disabled: assignBusy,
                title: assignBusy ? t('assign_new_plan_busy_hint') : undefined,
              },
              ...(plan.status !== 'cancelled'
                ? [{ label: t('action_cancel_plan'), onClick: () => onCancelPlan(plan), danger: true }]
                : []),
            ]}
          />
        )}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: 4 }}>
      <span style={{ color: '#888', minWidth: 120, fontSize: 13 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

const dim: CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
const fieldLabel: CSSProperties = { fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 2 };
const hint: CSSProperties = { color: '#888', fontSize: 13, margin: '0 0 12px' };
const card: CSSProperties = {
  background: '#fff', border: '1px solid #e8e8ed', borderRadius: 6,
  padding: '10px 14px', marginBottom: 8,
};
const subLabel: CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#aaa', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: 4,
};
const addBtn: CSSProperties = {
  background: 'none', border: '1px dashed #c8c8d0', borderRadius: 6,
  padding: '6px 12px', fontSize: 13, cursor: 'pointer', color: '#444', marginTop: 2,
};
const editorStyle: CSSProperties = {
  background: '#f8f8fb', border: '1px solid #e8e8ed', borderRadius: 6,
  padding: '12px 14px', marginTop: 8,
};
const editorTitle: CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 8 };
const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555' };
const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #d1d5db', fontSize: 13, margin: '6px 0 12px',
};
const errorStyle: CSSProperties = { color: '#c0392b', fontSize: 13, margin: '0 0 10px' };
const saveBtn: CSSProperties = {
  background: '#6c63ff', color: '#fff', border: 'none', borderRadius: 4,
  padding: '6px 14px', fontSize: 13, cursor: 'pointer',
};
const cancelBtn: CSSProperties = {
  background: 'none', border: '1px solid #d0d0d0', borderRadius: 4,
  padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: '#444',
};

function optionRow(checked: boolean): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6,
    border: `1px solid ${checked ? '#bfdbfe' : '#e5e7eb'}`,
    background: checked ? '#eff6ff' : '#fff',
    color: checked ? '#1d4ed8' : 'inherit',
    cursor: 'pointer', fontSize: 13, userSelect: 'none',
  };
}
