'use client';

import { useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { activePlanConflict, type ActivePlanConflict } from '@/lib/activePlanConflict';
import { ReplacePlanDialog } from '@/components/ReplacePlanDialog';
import {
  cardHintStyle,
  formControlStyle,
  formFieldLabelStyle,
  inlineActionsRowStyle,
  inlineEditorStyle,
  inlineEditorTitleStyle,
  rowRemoveBtnStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import { MemberSearchInput, MemberResult } from '../calendar/MemberSearchInput';

export interface AssignablePlan {
  id: number;
  name: string;
  member_limit: '1' | '2' | 'family';
  /** #1659: a Draft plan is listed (with its status) but cannot be assigned until it is Active. */
  lifecycle_status?: string;
}
type Plan = AssignablePlan;

interface Props {
  /** The Plan being assigned (Plans page). Omitted when launched from a Member. */
  plan?: Plan;
  /**
   * #1450: launched from a Member's profile the Plan is not known yet, so the
   * editor offers this list as a picker. Everything else is the same workflow.
   */
  planOptions?: Plan[];
  /** #1450: the Member the workflow was launched from — selected, and the owner. */
  initialMember?: MemberResult;
  onCancel: () => void;
  onAssigned: () => void;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * #1460: Assign Plan to Member(s), inline — the replacement for the former
 * `AssignPlanModal`. One workflow, two hosts: the plan's own card on the Plans
 * page (`plan`), and the Member card's `+ Add Membership Plan` (`planOptions` +
 * `initialMember`, #1450).
 *
 * No Benefits checklist: what a plan carries is the plan's own configuration
 * and is not asked for at assignment, so the request names no
 * `declined_benefits` and every benefit follows the plan.
 *
 * #956 stage 2: this is the one assignment path that assigns a *set* of
 * members, and the server answers all-or-nothing — so the 409 lists every plan
 * Continue cancels and the shared `ReplacePlanDialog` names them all before the
 * resend carries `confirm: true`.
 */
export function AssignPlanToMembersEditor({ plan: fixedPlan, planOptions, initialMember, onCancel, onAssigned }: Props) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();

  const [pickedPlanId, setPickedPlanId] = useState<number | null>(null);
  const plan: Plan | null = fixedPlan ?? planOptions?.find((p) => p.id === pickedPlanId) ?? null;
  const [members, setMembers] = useState<MemberResult[]>(initialMember ? [initialMember] : []);
  const [ownerId, setOwnerId] = useState<number | null>(initialMember?.id ?? null);
  const [startsAt, setStartsAt] = useState(todayISO());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ActivePlanConflict | null>(null);

  const limitCount = !plan || plan.member_limit === 'family' ? null : parseInt(plan.member_limit, 10);
  const overCapacity = limitCount != null && members.length > limitCount;

  function addMember(m: MemberResult) {
    if (members.some((x) => x.id === m.id)) return;
    setMembers((prev) => [...prev, m]);
    if (ownerId === null) setOwnerId(m.id);
  }

  function removeMember(id: number) {
    setMembers((prev) => prev.filter((m) => m.id !== id));
    if (ownerId === id) setOwnerId(null);
  }

  async function handleSubmit(confirmReplacement = false) {
    setError(null);
    if (!plan) { setError(t('members.assign_new_plan_error_no_plan')); return; }
    if (members.length === 0) { setError(t('plans.assign_error_no_members')); return; }
    if (limitCount != null && members.length !== limitCount) {
      setError(t('plans.assign_error_exact_count', { count: limitCount }));
      return;
    }
    if (ownerId === null) { setError(t('plans.assign_error_no_owner')); return; }
    if (!startsAt) { setError(t('plans.assign_error_no_start')); return; }

    setSaving(true);
    try {
      await apiFetch(`/membership-plans/${plan.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          member_ids: members.map((m) => m.id),
          owner_member_id: ownerId,
          starts_at: startsAt,
          ...(confirmReplacement ? { confirm: true } : {}),
        }),
      });
      setConflict(null);
      onAssigned();
    } catch (err: any) {
      const replacement = confirmReplacement ? null : activePlanConflict(err);
      if (replacement) {
        setConflict(replacement);
      } else {
        setConflict(null);
        setError(apiErrorMessage(err) ?? t('plans.error_generic'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={editorStyle}>
      <div style={editorTitleStyle}>{t('plans.assign_title')}</div>
      {fixedPlan ? (
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#888' }}>{fixedPlan.name}</p>
      ) : (
        <>
          <label style={formFieldLabelStyle}>{t('members.assign_new_plan_label_plan')}</label>
          <select
            value={pickedPlanId ?? ''}
            onChange={(e) => setPickedPlanId(e.target.value ? parseInt(e.target.value, 10) : null)}
            disabled={saving}
            style={{ ...formControlStyle, margin: '6px 0 12px' }}
          >
            <option value="">{t('members.assign_new_plan_pick_plan')}</option>
            {(planOptions ?? []).map((p) => {
              const notAssignable = p.lifecycle_status != null && p.lifecycle_status !== 'active';
              return (
                <option key={p.id} value={p.id} disabled={notAssignable}>
                  {notAssignable ? `${p.name} (${t('members.product_set_status_draft')})` : p.name}
                </option>
              );
            })}
          </select>
        </>
      )}

      {plan && (
        <label style={formFieldLabelStyle}>
          {t('plans.assign_capacity_label', { limit: plan.member_limit === 'family' ? t('plans.assign_family') : plan.member_limit })}
        </label>
      )}
      <div style={{ margin: '6px 0 12px' }}>
        <MemberSearchInput placeholder={t('plans.assign_search_placeholder')} onSelect={addMember} disabled={saving} />
      </div>

      {overCapacity && (
        <p style={{ margin: '0 0 10px', fontSize: 12, color: '#b45309', background: '#fffbeb', padding: '6px 10px', borderRadius: 6 }}>
          ⚠ {t('plans.assign_over_capacity', { count: members.length, limit: limitCount ?? 0 })}
        </p>
      )}

      {members.length === 0 ? (
        <p style={{ ...cardHintStyle, marginBottom: 12 }}>{t('plans.assign_no_members_selected')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {members.map((m) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(0,0,0,0.03)', borderRadius: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name={`owner-${fixedPlan?.id ?? 'member'}`}
                  checked={ownerId === m.id}
                  onChange={() => setOwnerId(m.id)}
                  disabled={saving}
                />
                <span style={{ fontWeight: 600 }}>{m.name}</span>
                <span style={{ color: '#888' }}>{m.email}</span>
                {ownerId === m.id && (
                  <span style={{ fontSize: 10, fontWeight: 600, color: '#6c63ff', background: '#eeecff', padding: '1px 6px', borderRadius: 3 }}>
                    {t('plans.assign_owner_badge')}
                  </span>
                )}
              </label>
              <button
                onClick={() => removeMember(m.id)}
                disabled={saving}
                aria-label={m.name}
                style={rowRemoveBtnStyle}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      <label style={formFieldLabelStyle}>{t('plans.assign_starts_at_label')}</label>
      <input
        type="date"
        value={startsAt}
        onChange={(e) => setStartsAt(e.target.value)}
        disabled={saving}
        style={{ ...formControlStyle, margin: '6px 0 12px' }}
      />

      {error && <p style={{ color: '#c0392b', fontSize: 13, margin: '0 0 10px' }}>{error}</p>}

      <div style={inlineActionsRowStyle}>
        <button onClick={() => handleSubmit()} disabled={saving} style={primaryBtnSmall()}>
          {saving ? t('plans.saving') : t('plans.assign_submit')}
        </button>
        <button onClick={onCancel} disabled={saving} style={secondaryBtnSmall}>
          {t('plans.cancel')}
        </button>
      </div>

      <ReplacePlanDialog
        conflict={conflict}
        newPlanName={plan?.name ?? null}
        busy={saving}
        onConfirm={() => handleSubmit(true)}
        onCancel={() => setConflict(null)}
      />
    </div>
  );
}

const editorStyle: CSSProperties = { ...inlineEditorStyle, margin: 10 };
const editorTitleStyle: CSSProperties = { ...inlineEditorTitleStyle, marginBottom: 2 };
