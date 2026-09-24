'use client';

// #634 §3 — PROMOTIONS, a section of its own.
//
// Promotions are managed at Member level and are never nested inside a
// Membership Plan card (§13). A Promotion still applies *to* one of the
// Member's Membership Plans — that is what the compatibility rules are about —
// so each row names the plan it is attached to, and adding one starts by
// choosing which plan it applies to.
//
// Every eligibility rule is the server's (POST /user-memberships/:id/promotions):
// the Promotion must be active and inside its window, must target that plan,
// must satisfy the stacking rules, and, when it is flagged "Only applicable for
// new members", the Member must qualify. Nothing here re-implements them — the
// picker only avoids offering combinations the API would refuse, and surfaces
// the server's message when one slips through.

import React, { useEffect, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { StatusBadge } from '@/components/StatusBadge';
import type { MemberPlanRow, MemberPromotionRow } from './membershipConfiguration';

interface EligiblePromotion {
  id: number;
  name: string;
  stackable: boolean | number;
  /** MySQL TINYINT(1), i.e. 0/1 over JSON. */
  only_applicable_for_new_members: boolean | number;
}

interface Props {
  plans: MemberPlanRow[];
  promotions: MemberPromotionRow[];
  canWrite: boolean;
  /** Re-reads the configuration and re-runs the Billing Simulation (§12). */
  onChanged: () => void;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

export function MemberPromotions({ plans, promotions, canWrite, onChanged }: Props) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();

  const [adding, setAdding] = useState(false);
  const [targetPlanId, setTargetPlanId] = useState<number | null>(null);
  const [eligible, setEligible] = useState<EligiblePromotion[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [draftPromotionId, setDraftPromotionId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A Promotion can only be attached to a plan that still bills, and only to
  // one that actually references a Membership Plan (the targeting check joins
  // promotion_membership_plans).
  const targets = plans.filter((p) => p.is_live && p.membership_plan_id != null);
  const target = targets.find((p) => p.id === targetPlanId) ?? null;
  const applied = promotions.filter((p) => p.status === 'applied');
  const revoked = promotions.filter((p) => p.status !== 'applied');

  // Eligible Promotions for the chosen plan. `active_on` and
  // `membership_plan_id` mirror what the apply path checks, so the list is what
  // the server would accept rather than every Promotion in the gym.
  useEffect(() => {
    setDraftPromotionId(null);
    if (targetPlanId == null || target?.membership_plan_id == null) { setEligible([]); return; }

    let cancelled = false;
    setEligibleLoading(true);
    apiFetch<EligiblePromotion[]>(
      `/promotions?lifecycle_status=active&active_on=${todayISO()}&membership_plan_id=${target.membership_plan_id}`,
    )
      .then((rows) => { if (!cancelled) setEligible(rows); })
      .catch(() => { if (!cancelled) setEligible([]); })
      .finally(() => { if (!cancelled) setEligibleLoading(false); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPlanId]);

  // Already applied to the chosen plan — the same promotion can't be applied
  // twice, and the stacking rules are evaluated against what is already there.
  const appliedOnTarget = applied.filter((p) => p.user_membership_id === targetPlanId);
  const appliedIdsOnTarget = new Set(appliedOnTarget.map((p) => p.promotion_id));
  const nonStackableApplied = appliedOnTarget.some((p) => !p.stackable);

  function blockedReason(p: EligiblePromotion): string | null {
    if (appliedIdsOnTarget.has(p.id)) return t('promotions_already_applied');
    // §3 — "Only applicable for new members": the Member must not have held
    // another Membership Plan in the trailing 12 months. `new_member_eligible`
    // is the server's own answer for this plan (the plan a Promotion attaches
    // to never counts against its Member), so the picker and the API agree.
    if (p.only_applicable_for_new_members && target && !target.new_member_eligible) {
      return t('promotions_blocked_new_members_only');
    }
    if (nonStackableApplied) return t('assign_new_plan_promotion_blocked_by_non_stackable');
    if (appliedOnTarget.length > 0 && !p.stackable) return t('assign_new_plan_promotion_blocked_non_stackable');
    return null;
  }

  function startAdding() {
    setAdding(true);
    setTargetPlanId(targets.length === 1 ? targets[0].id : null);
    setDraftPromotionId(null);
    setError(null);
  }

  async function save() {
    if (targetPlanId == null) { setError(t('promotions_error_no_plan')); return; }
    if (draftPromotionId == null) { setError(t('promotions_error_no_promotion')); return; }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/user-memberships/${targetPlanId}/promotions`, {
        method: 'POST',
        body: JSON.stringify({ promotion_id: draftPromotionId }),
      });
      setAdding(false);
      setDraftPromotionId(null);
      onChanged();
    } catch (err: any) {
      setError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: MemberPromotionRow) {
    setError(null);
    try {
      await apiFetch(`/user-memberships/${row.user_membership_id}/promotions/${row.promotion_id}`, { method: 'DELETE' });
      onChanged();
    } catch (err: any) {
      setError(err.message ?? t('error_generic'));
    }
  }

  return (
    <div>
      {applied.length === 0 ? (
        <p style={dim}>{t('promotions_none')}</p>
      ) : (
        applied.map((row) => (
          <div key={`${row.user_membership_id}-${row.promotion_id}`} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 14 }}>{row.promotion_name ?? '—'}</div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                  {t('promotions_on_plan', { plan: row.plan_name ?? '—' })} · {fmtDate(row.applied_at)}
                </div>
              </div>
              {canWrite && (
                <button onClick={() => remove(row)} style={removeBtn}>{t('promotions_remove')}</button>
              )}
            </div>
          </div>
        ))
      )}

      {canWrite && !adding && targets.length > 0 && (
        <button onClick={startAdding} style={addBtn}>{t('promotions_add')}</button>
      )}
      {canWrite && !adding && targets.length === 0 && (
        <p style={dim}>{t('promotions_needs_plan')}</p>
      )}

      {adding && (
        <div style={editorStyle}>
          <div style={editorTitle}>{t('promotions_add_title')}</div>

          <div style={labelStyle}>{t('promotions_label_plan')}</div>
          <select
            value={targetPlanId ?? ''}
            onChange={(e) => setTargetPlanId(e.target.value ? Number(e.target.value) : null)}
            disabled={saving}
            style={selectStyle}
          >
            <option value="">{t('promotions_pick_plan')}</option>
            {targets.map((p) => (
              <option key={p.id} value={p.id}>{p.plan_name ?? `#${p.id}`}</option>
            ))}
          </select>

          <div style={labelStyle}>{t('promotions_label_promotion')}</div>
          {targetPlanId == null ? (
            <p style={hint}>{t('promotions_pick_plan_first')}</p>
          ) : eligibleLoading ? (
            <p style={hint}>{t('assign_new_plan_promotions_loading')}</p>
          ) : eligible.length === 0 ? (
            <p style={hint}>{t('assign_new_plan_promotions_none')}</p>
          ) : (
            <div role="radiogroup" aria-label={t('promotions_label_promotion')} style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 12px' }}>
              {eligible.map((p) => {
                const blocked = blockedReason(p);
                return (
                  <label key={p.id} title={blocked ?? undefined} style={optionRow(draftPromotionId === p.id, blocked !== null)}>
                    <input
                      type="radio"
                      name={`add-promotion-${targetPlanId}`}
                      checked={draftPromotionId === p.id}
                      disabled={saving || blocked !== null}
                      onChange={() => setDraftPromotionId(p.id)}
                      style={{ marginRight: 8 }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>{p.name}</span>
                    <span style={stackTag(!!p.stackable)}>
                      {p.stackable
                        ? t('assign_new_plan_promotion_stackable')
                        : t('assign_new_plan_promotion_non_stackable')}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {error && <p style={errorStyle}>{error}</p>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={saving} style={saveBtn}>
              {saving ? t('saving') : t('promotions_submit')}
            </button>
            <button onClick={() => { setAdding(false); setError(null); }} disabled={saving} style={cancelBtn}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {!adding && error && <p style={errorStyle}>{error}</p>}

      {revoked.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={subLabel}>{t('promotions_history')}</div>
          {revoked.map((row) => (
            <div key={`${row.user_membership_id}-${row.promotion_id}`} style={{ ...card, opacity: 0.75 }}>
              <div style={{ fontSize: 14 }}>{row.promotion_name ?? '—'}</div>
              <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <StatusBadge status={row.status} label={row.status} />
                <span style={{ fontSize: 12, color: '#888' }}>
                  {t('promotions_on_plan', { plan: row.plan_name ?? '—' })} · {fmtDate(row.revoked_at)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const dim: CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
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
const removeBtn: CSSProperties = {
  background: 'none', border: '1px solid #d0d0d0', borderRadius: 4,
  padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: '#444', flexShrink: 0,
};
const editorStyle: CSSProperties = {
  background: '#f8f8fb', border: '1px solid #e8e8ed', borderRadius: 6,
  padding: '12px 14px', marginTop: 8,
};
const editorTitle: CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 8 };
const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555' };
const selectStyle: CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, background: '#fff',
  border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box', margin: '6px 0 12px',
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

function optionRow(checked: boolean, disabled: boolean): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6,
    border: `1px solid ${checked ? '#bfdbfe' : '#e5e7eb'}`,
    background: checked ? '#eff6ff' : '#fff',
    color: checked ? '#1d4ed8' : 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontSize: 13, userSelect: 'none',
  };
}

function stackTag(stackable: boolean): CSSProperties {
  return {
    fontSize: 11, fontWeight: 600, color: stackable ? '#15803d' : '#b45309',
    background: stackable ? '#f0fdf4' : '#fffbeb',
    border: `1px solid ${stackable ? '#bbf7d0' : '#fde68a'}`,
    borderRadius: 10, padding: '1px 8px', flexShrink: 0,
  };
}
