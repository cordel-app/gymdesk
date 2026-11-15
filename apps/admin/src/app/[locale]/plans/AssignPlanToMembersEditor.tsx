'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { activePlanConflict, conflictChoiceBody, type ActivePlanConflict, type ConflictChoice } from '@/lib/activePlanConflict';
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
import { PromotionPicker, type PickerPromotion } from '@/components/PromotionPicker';
import { promotionBenefitDescription, revalidateSelection } from '@/lib/promotionSelection';

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
  /** `created` is the assignment the API returned (#1692) — used to open its card. */
  onAssigned: (created?: { id: number }) => void;
}

/** A Promotion targeting the Plan, as `GET /promotions?…&for_member_id=` reports it. */
interface AssignablePromotion {
  id: number;
  name: string;
  /** #2852: the Promotion's stored images, for the picker's thumbnail. */
  image_url?: string | null;
  image_thumbnail_url?: string | null;
  modified_at?: string | null;
  stackable: number | boolean;
  fee_benefit_action: string | null;
  fee_benefit_value: number | string | null;
  fee_benefit_duration_months: number | null;
  /** The owner may take it (#2809); absent when no owner is chosen yet. */
  member_eligible?: boolean;
  ineligible_reason?: string | null;
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
 * #2809: Promotions are chosen here and never applied automatically. The
 * section lists the active Promotions targeting the Plan, each judged by the
 * server for the owner (`GET /promotions?for_member_id=`), with the stacking
 * rule enforced by `PromotionPicker`; only the selection is sent as
 * `promotion_ids`, and the server re-validates it as a set.
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
  // #2809: the Promotions offered for this assignment, and the ones staff chose.
  // Nothing is applied unless it is selected.
  const [promotions, setPromotions] = useState<AssignablePromotion[]>([]);
  const [promotionsLoading, setPromotionsLoading] = useState(false);
  const [selectedPromotionIds, setSelectedPromotionIds] = useState<number[]>([]);
  const planId = plan?.id ?? null;

  // The Promotions targeting the Plan, active today, each judged by the server
  // for the owner (Only New Members). Re-read when the Plan or the owner
  // changes, and the selection is re-validated against what is still offered.
  useEffect(() => {
    if (!planId) { setPromotions([]); setSelectedPromotionIds([]); return; }
    let cancelled = false;
    setPromotionsLoading(true);
    const owner = ownerId != null ? `&for_member_id=${ownerId}` : '';
    apiFetch<AssignablePromotion[]>(
      `/promotions?lifecycle_status=active&active_on=${todayISO()}&membership_plan_id=${planId}${owner}`,
    )
      .then((rows) => {
        if (cancelled) return;
        setPromotions(rows);
        const offered = rows
          .filter((p) => p.member_eligible !== false)
          .map((p) => ({ id: p.id, stackable: !!p.stackable }));
        setSelectedPromotionIds((prev) => revalidateSelection(prev, offered));
      })
      .catch(() => { if (!cancelled) { setPromotions([]); setSelectedPromotionIds([]); } })
      .finally(() => { if (!cancelled) setPromotionsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, ownerId]);

  const pickerPromotions: PickerPromotion[] = promotions.map((p) => {
    const d = p.fee_benefit_action
      ? promotionBenefitDescription(
          {
            action: p.fee_benefit_action,
            value: p.fee_benefit_value == null ? null : Number(p.fee_benefit_value),
            duration_cycles: p.fee_benefit_duration_months ?? null,
          },
          (n) => `${n.toFixed(2)}€`,
        )
      : null;
    return {
      id: p.id,
      name: p.name,
      stackable: !!p.stackable,
      description: d ? t(`members.${d.key}` as any, d.values as any) : null,
      imageUrl: p.image_thumbnail_url ?? p.image_url ?? null,
      imageStamp: p.modified_at ?? null,
      unavailableReason: p.member_eligible === false
        ? t(`members.promo_block_${p.ineligible_reason ?? 'new_members_only'}` as any)
        : null,
    };
  });

  const limitCount = !plan || plan.member_limit === 'family' ? null : parseInt(plan.member_limit, 10);
  const overCapacity = limitCount != null && members.length > limitCount;
  const atCapacity = limitCount != null && members.length >= limitCount;

  function addMember(m: MemberResult) {
    if (members.some((x) => x.id === m.id)) return;
    if (atCapacity) return;
    setMembers((prev) => [...prev, m]);
    if (ownerId === null) setOwnerId(m.id);
  }

  function removeMember(id: number) {
    setMembers((prev) => prev.filter((m) => m.id !== id));
    if (ownerId === id) setOwnerId(null);
  }

  async function handleSubmit(confirmReplacement: ConflictChoice = false) {
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
      const created = await apiFetch<{ id?: number }>(`/membership-plans/${plan.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          member_ids: members.map((m) => m.id),
          owner_member_id: ownerId,
          starts_at: startsAt,
          promotion_ids: selectedPromotionIds,
          ...conflictChoiceBody(confirmReplacement),
        }),
      });
      setConflict(null);
      onAssigned(typeof created?.id === 'number' ? { id: created.id } : undefined);
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
      {!atCapacity && (
        <div style={{ margin: '6px 0 12px' }}>
          <MemberSearchInput placeholder={t('plans.assign_search_placeholder')} onSelect={addMember} disabled={saving} />
        </div>
      )}

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

      {plan && (
        <>
          <label style={formFieldLabelStyle}>{t('members.assign_new_plan_section_promotions')}</label>
          <p style={{ ...cardHintStyle, margin: '4px 0 8px' }}>{t('members.assign_promotions_hint')}</p>
          <div style={{ marginBottom: 12 }}>
            {promotionsLoading ? (
              <p style={cardHintStyle}>{t('members.assign_new_plan_promotions_loading')}</p>
            ) : (
              <PromotionPicker
                promotions={pickerPromotions}
                selectedIds={selectedPromotionIds}
                onToggle={(id) => setSelectedPromotionIds((prev) => (
                  prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                ))}
                disabled={saving}
                emptyText={t('members.assign_new_plan_promotions_none')}
                showThumbnails
              />
            )}
          </div>
        </>
      )}

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
        onAdd={() => handleSubmit('add')}
        onCancel={() => setConflict(null)}
      />
    </div>
  );
}

const editorStyle: CSSProperties = { ...inlineEditorStyle, margin: 10 };
const editorTitleStyle: CSSProperties = { ...inlineEditorTitleStyle, marginBottom: 2 };
