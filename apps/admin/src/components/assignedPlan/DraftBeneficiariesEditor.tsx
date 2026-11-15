'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import {
  PLAN_MEMBER_LIMITS,
  beneficiaryDraftChanged,
  beneficiarySelectionIssue,
  canSelectBeneficiary,
  familyOwnerId,
  orderFamilyMembers,
  toggleBeneficiary,
  type FamilyMemberOption,
  type PlanMemberLimit,
} from '@/lib/planBeneficiaries';
import {
  cardHintStyle,
  formControlStyle,
  formErrorStyle,
  formFieldLabelStyle,
  inlineActionsRowStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';

interface BeneficiaryState {
  editable: boolean;
  owner_member_id: number;
  member_limit: PlanMemberLimit;
  beneficiary_member_ids: number[];
}

/**
 * #2879 stage 2 — a Draft assignment's Members per Membership and its beneficiaries,
 * edited together inside the Assigned Plan card's Edit mode. The toggles and the limit are
 * the stage-1 rules (`lib/planBeneficiaries.ts`); the server judges the pair again on
 * `PUT /user-memberships/:id/beneficiaries`. Save stays disabled until the selection matches
 * the count, and `onBlockingChange` tells the card to hold its own Save & Pay meanwhile.
 */
export function DraftBeneficiariesEditor({
  assignedPlanId, canWrite, readOnlyTitle, onSaved, onBlockingChange,
}: {
  assignedPlanId: number;
  canWrite: boolean;
  readOnlyTitle?: string;
  onSaved: () => void;
  onBlockingChange: (blocking: boolean) => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const [saved, setSaved] = useState<BeneficiaryState | null>(null);
  const [family, setFamily] = useState<FamilyMemberOption[]>([]);
  const [memberLimit, setMemberLimit] = useState<PlanMemberLimit>('1');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const state = await apiFetch<BeneficiaryState>(`/user-memberships/${assignedPlanId}/beneficiaries`);
        if (cancelled) return;
        setSaved(state);
        setMemberLimit(state.member_limit);
        setSelectedIds(state.beneficiary_member_ids);
        const res = await apiFetch<{ family: { members: FamilyMemberOption[] } | null }>(
          `/members/${state.owner_member_id}/family`).catch(() => null);
        if (cancelled) return;
        const rows = res?.family?.members?.length
          ? res.family.members
          : [{ member_id: state.owner_member_id, name: String(state.owner_member_id), is_owner: true }];
        setFamily(orderFamilyMembers(rows));
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err) ?? t('assigned_plans_page.error_generic'));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignedPlanId]);

  const changed = saved != null && beneficiaryDraftChanged(
    { memberLimit: saved.member_limit, ids: saved.beneficiary_member_ids },
    { memberLimit, ids: selectedIds },
  );
  const issue = family.length > 0 ? beneficiarySelectionIssue(family, selectedIds, memberLimit) : null;

  useEffect(() => {
    onBlockingChange(changed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed]);
  useEffect(() => () => onBlockingChange(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!saved) return error ? <p style={formErrorStyle}>{error}</p> : null;
  if (!saved.editable) return null;

  const ownerId = familyOwnerId(family);

  function issueText(): string | null {
    if (!issue) return null;
    if (issue.key === 'not_enough_family_members') return t('plans.assign_not_enough_family', { count: issue.count });
    if (issue.key === 'none_selected') return t('plans.assign_error_no_members');
    return t('plans.assign_error_exact_count', { count: issue.count });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const state = await apiFetch<BeneficiaryState>(`/user-memberships/${assignedPlanId}/beneficiaries`, {
        method: 'PUT',
        body: JSON.stringify({ member_limit: memberLimit, beneficiary_member_ids: selectedIds }),
      });
      setSaved(state);
      setMemberLimit(state.member_limit);
      setSelectedIds(state.beneficiary_member_ids);
      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err) ?? t('assigned_plans_page.error_generic'));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setMemberLimit(saved!.member_limit);
    setSelectedIds(saved!.beneficiary_member_ids);
    setError(null);
  }

  return (
    <div style={{ marginTop: 12 }}>
      <label style={formFieldLabelStyle} htmlFor={`member-limit-${assignedPlanId}`}>{t('plans.label_member_limit')}</label>
      <select
        id={`member-limit-${assignedPlanId}`}
        value={memberLimit}
        disabled={busy || !canWrite}
        title={canWrite ? undefined : readOnlyTitle}
        onChange={(e) => setMemberLimit(e.target.value as PlanMemberLimit)}
        style={{ ...formControlStyle, maxWidth: 220, marginBottom: 10 }}
      >
        {PLAN_MEMBER_LIMITS.map((m) => <option key={m} value={m}>{t(`plans.member_limit_${m}`)}</option>)}
      </select>
      <p style={{ ...cardHintStyle, margin: '0 0 8px' }}>{t('assigned_plans_page.beneficiaries_draft_hint')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {family.map((m) => {
          const checked = selectedIds.includes(m.member_id);
          const blocked = !canSelectBeneficiary(selectedIds, m.member_id, memberLimit);
          return (
            <label
              key={m.member_id}
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.6 : 1 }}
            >
              <input
                type="checkbox"
                role="switch"
                checked={checked}
                disabled={busy || blocked || !canWrite}
                onChange={() => setSelectedIds((prev) => toggleBeneficiary(prev, m.member_id, memberLimit))}
              />
              <span style={{ fontWeight: 600 }}>{m.name}</span>
              {m.email && <span style={{ color: '#888' }}>{m.email}</span>}
              {m.member_id === ownerId && <span style={{ color: '#888', fontSize: 12 }}>({t('plans.assign_owner_badge')})</span>}
            </label>
          );
        })}
      </div>
      {issue && <p style={formErrorStyle}>{issueText()}</p>}
      {error && <p style={formErrorStyle}>{error}</p>}
      {changed && (
        <div style={inlineActionsRowStyle}>
          <button type="button" style={secondaryBtnSmall} disabled={busy} onClick={reset}>
            {t('assigned_plans_page.action_beneficiaries_cancel')}
          </button>
          <button
            type="button"
            style={primaryBtnSmall()}
            disabled={busy || !canWrite || issue != null}
            title={canWrite ? undefined : readOnlyTitle}
            onClick={save}
          >
            {t('assigned_plans_page.action_beneficiaries_save')}
          </button>
        </div>
      )}
    </div>
  );
}
