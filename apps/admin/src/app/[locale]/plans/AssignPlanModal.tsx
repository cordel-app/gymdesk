'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { activePlanConflict, type ActivePlanConflict } from '@/lib/activePlanConflict';
import { ReplacePlanDialog } from '@/components/ReplacePlanDialog';
import { btnStyle, modalStyle, overlayStyle, primaryBtnStyle } from '@/components/ui';
import {
  BENEFIT_ENDPOINTS, benefitKey, declinedPayload, toAssignableBenefits,
  type AssignableBenefit,
} from '@/lib/declinedBenefits';
import { MemberSearchInput, MemberResult } from '../calendar/MemberSearchInput';

interface Plan {
  id: number;
  name: string;
  member_limit: '1' | '2' | 'family';
}

interface Props {
  plan: Plan;
  onClose: () => void;
  onAssigned: () => void;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * #956 stage 2: this is the one assignment path that assigns a *set* of
 * members, and the server answers all-or-nothing — a run that replaced three
 * members' plans and refused the fourth would leave the gym with cancellations
 * it did not get to weigh. So the 409 lists every plan Continue cancels and the
 * shared `ReplacePlanDialog` names them all before the resend carries
 * `confirm: true`.
 */
export function AssignPlanModal({ plan, onClose, onAssigned }: Props) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();

  const [members, setMembers] = useState<MemberResult[]>([]);
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [startsAt, setStartsAt] = useState(todayISO());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ActivePlanConflict | null>(null);
  // #1184 stage 3b: the Plan's benefits; unticking an optional one declines it for everyone assigned.
  const [benefits, setBenefits] = useState<AssignableBenefit[]>([]);
  const [declinedKeys, setDeclinedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    Promise.all(BENEFIT_ENDPOINTS.map(([section, path]) =>
      apiFetch<any[]>(`/membership-plans/${plan.id}/${path}`)
        .then((rows) => toAssignableBenefits(section, rows))
        .catch(() => [] as AssignableBenefit[]),
    )).then((groups) => { if (!cancelled) setBenefits(groups.flat()); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.id]);

  function toggleBenefit(b: AssignableBenefit) {
    setDeclinedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(benefitKey(b))) next.delete(benefitKey(b)); else next.add(benefitKey(b));
      return next;
    });
  }

  const limitCount = plan.member_limit === 'family' ? null : parseInt(plan.member_limit, 10);
  const overCapacity = limitCount != null && members.length > limitCount;

  function addMember(m: MemberResult) {
    if (members.some((x) => x.id === m.id)) return;
    setMembers((prev) => {
      const next = [...prev, m];
      if (ownerId === null) setOwnerId(m.id);
      return next;
    });
  }

  function removeMember(id: number) {
    setMembers((prev) => prev.filter((m) => m.id !== id));
    if (ownerId === id) setOwnerId(null);
  }

  async function handleSubmit(confirmReplacement = false) {
    setError(null);
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
          declined_benefits: declinedPayload(benefits, declinedKeys),
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
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>{t('plans.assign_title')}</h3>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#888' }}>{plan.name}</p>

        <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>
          {t('plans.assign_capacity_label', { limit: plan.member_limit === 'family' ? t('plans.assign_family') : plan.member_limit })}
        </label>

        <div style={{ margin: '6px 0 12px' }}>
          <MemberSearchInput placeholder={t('plans.assign_search_placeholder')} onSelect={addMember} disabled={saving} />
        </div>

        {overCapacity && (
          <p style={{ margin: '0 0 10px', fontSize: 12, color: '#b45309', background: '#fffbeb', padding: '6px 10px', borderRadius: 6 }}>
            ⚠ {t('plans.assign_over_capacity', { count: members.length, limit: limitCount ?? 0 })}
          </p>
        )}

        {members.length === 0 ? (
          <p style={{ fontSize: 13, color: '#888' }}>{t('plans.assign_no_members_selected')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {members.map((m) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(0,0,0,0.03)', borderRadius: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="owner"
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
                <button onClick={() => removeMember(m.id)} disabled={saving} style={{ background: 'none', border: 'none', color: '#c0392b', cursor: 'pointer', fontSize: 14 }}>✕</button>
              </div>
            ))}
          </div>
        )}

        <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>{t('plans.assign_starts_at_label')}</label>
        <input
          type="date"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          disabled={saving}
          style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, margin: '6px 0 12px' }}
        />

        {benefits.length > 0 && (
          <>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>{t('members.assign_new_plan_section_benefits')}</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '6px 0 12px' }}>
              {benefits.map((b) => (
                <label
                  key={benefitKey(b)}
                  title={b.mandatory ? t('members.assign_new_plan_benefit_mandatory_hint') : undefined}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
                >
                  <input
                    type="checkbox"
                    checked={b.mandatory || !declinedKeys.has(benefitKey(b))}
                    disabled={saving || b.mandatory}
                    onChange={() => toggleBenefit(b)}
                  />
                  <span style={{ flex: 1 }}>{b.product_name}</span>
                  <span style={{ fontSize: 11, color: '#888' }}>
                    {b.mandatory ? t('members.assign_new_plan_benefit_mandatory') : t('members.assign_new_plan_benefit_optional')}
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        {error && <p style={{ color: '#c0392b', fontSize: 13, margin: '0 0 12px' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnStyle('#aaa')} disabled={saving}>{t('plans.cancel')}</button>
          <button onClick={() => handleSubmit()} style={primaryBtnStyle()} disabled={saving}>
            {saving ? t('plans.saving') : t('plans.assign_submit')}
          </button>
        </div>

        <ReplacePlanDialog
          conflict={conflict}
          newPlanName={plan.name}
          busy={saving}
          onConfirm={() => handleSubmit(true)}
          onCancel={() => setConflict(null)}
        />
      </div>
    </div>
  );
}
