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
import { revalidateSelection } from '@/lib/promotionSelection';
import { assignablePromotionsPath, toPickerPromotion, type AssignablePromotion } from '@/lib/assignablePromotions';
import {
  beneficiarySelectionIssue,
  canSelectBeneficiary,
  defaultBeneficiaryIds,
  familyOwnerId,
  orderFamilyMembers,
  toggleBeneficiary,
  type FamilyMemberOption,
} from '@/lib/planBeneficiaries';

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
 * #2879: the beneficiaries are chosen from the family of the member the plan is
 * assigned for, one toggle per family member (`lib/planBeneficiaries.ts`). The
 * family owner is the assignment's owner (the payer) and need not be a
 * beneficiary; the selection opens with the owner and then the others
 * alphabetically up to the plan's *Members per Membership*, and Save waits for
 * exactly that many.
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
  // #2879: the member the plan is for (preselected from a Member card), their family,
  // and the beneficiaries chosen from it.
  const [subject, setSubject] = useState<MemberResult | null>(initialMember ?? null);
  const [family, setFamily] = useState<FamilyMemberOption[]>([]);
  const [familyLoading, setFamilyLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const ownerId = familyOwnerId(family);
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
  const memberLimit = plan?.member_limit ?? null;

  // The family of the member the plan is for; a member with no family row is a
  // family of one.
  useEffect(() => {
    if (!subject) { setFamily([]); return; }
    let cancelled = false;
    setFamilyLoading(true);
    apiFetch<{ family: { members: FamilyMemberOption[] } | null }>(`/members/${subject.id}/family`)
      .then((res) => {
        if (cancelled) return;
        const rows = res?.family?.members?.length
          ? res.family.members
          : [{ member_id: subject.id, name: subject.name, email: subject.email, is_owner: true }];
        setFamily(orderFamilyMembers(rows));
      })
      .catch(() => {
        if (!cancelled) setFamily([{ member_id: subject.id, name: subject.name, email: subject.email, is_owner: true }]);
      })
      .finally(() => { if (!cancelled) setFamilyLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject?.id]);

  // The default selection, re-taken when the family or the plan's count changes.
  useEffect(() => {
    setSelectedIds(memberLimit ? defaultBeneficiaryIds(family, memberLimit) : []);
  }, [family, memberLimit]);

  // The Promotions targeting the Plan, active today, each judged by the server
  // for the owner (Only New Members). Re-read when the Plan or the owner
  // changes, and the selection is re-validated against what is still offered.
  useEffect(() => {
    if (!planId) { setPromotions([]); setSelectedPromotionIds([]); return; }
    let cancelled = false;
    setPromotionsLoading(true);
    apiFetch<AssignablePromotion[]>(
      assignablePromotionsPath({ membershipPlanId: planId, today: todayISO(), ownerMemberId: ownerId }),
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

  const pickerPromotions: PickerPromotion[] = promotions.map((p) => toPickerPromotion(p, t as any));

  const selectionIssue = plan && family.length > 0 ? beneficiarySelectionIssue(family, selectedIds, plan.member_limit) : null;

  function issueText(): string | null {
    if (!selectionIssue) return null;
    if (selectionIssue.key === 'not_enough_family_members') {
      return t('plans.assign_not_enough_family', { count: selectionIssue.count });
    }
    if (selectionIssue.key === 'none_selected') return t('plans.assign_error_no_members');
    return t('plans.assign_error_exact_count', { count: selectionIssue.count });
  }

  async function handleSubmit(confirmReplacement: ConflictChoice = false) {
    setError(null);
    if (!plan) { setError(t('members.assign_new_plan_error_no_plan')); return; }
    if (!subject || ownerId === null) { setError(t('plans.assign_error_no_members')); return; }
    if (selectionIssue) { setError(issueText()); return; }
    if (!startsAt) { setError(t('plans.assign_error_no_start')); return; }

    setSaving(true);
    try {
      const created = await apiFetch<{ id?: number }>(`/membership-plans/${plan.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          beneficiary_member_ids: selectedIds,
          owner_member_id: ownerId,
          starts_at: startsAt,
          promotion_ids: selectedPromotionIds,
          ...conflictChoiceBody(confirmReplacement),
        }),
      });
      setConflict(null);
      onAssigned(typeof created?.id === 'number' ? { id: created.id } : undefined);
    } catch (err: any) {
      // #2966 stage 3: the owner already has a cart (Draft) — the plan joins it as a snapshot.
      const setId = err?.status === 409 && err?.body?.code === 'in_flight' ? Number(err.body.product_set_id) : NaN;
      if (Number.isInteger(setId) && setId > 0 && plan) {
        try {
          await apiFetch(`/product-sets/${setId}/plans`, {
            method: 'POST',
            body: JSON.stringify({
              membership_plan_id: plan.id,
              starts_at: startsAt,
              owner_is_beneficiary: selectedIds.includes(ownerId),
              // #2966 stage 6: the beneficiaries picked here cover the added plan too, and the
              // selected Promotions are sent so the server refuses them rather than dropping them.
              beneficiary_member_ids: selectedIds,
              promotion_ids: selectedPromotionIds,
            }),
          });
          setConflict(null);
          onAssigned(undefined);
        } catch (addErr: any) {
          setConflict(null);
          setError(apiErrorMessage(addErr) ?? t('plans.error_generic'));
        } finally {
          setSaving(false);
        }
        return;
      }
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
                  {notAssignable ? `${p.name} (${t('status.draft')})` : p.name}
                </option>
              );
            })}
          </select>
        </>
      )}

      <label style={formFieldLabelStyle}>{t('plans.assign_member_label')}</label>
      {subject ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 12px', fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>{subject.name}</span>
          <span style={{ color: '#888' }}>{subject.email}</span>
          {!initialMember && (
            <button onClick={() => setSubject(null)} disabled={saving} aria-label={t('plans.assign_change_member')} style={rowRemoveBtnStyle}>✕</button>
          )}
        </div>
      ) : (
        <div style={{ margin: '6px 0 12px' }}>
          <MemberSearchInput placeholder={t('plans.assign_search_placeholder')} onSelect={setSubject} disabled={saving} />
        </div>
      )}

      {plan && subject && (
        <>
          <label style={formFieldLabelStyle}>
            {t('plans.assign_beneficiaries_label', { limit: plan.member_limit === 'family' ? t('plans.assign_family') : plan.member_limit })}
          </label>
          <p style={{ ...cardHintStyle, margin: '4px 0 8px' }}>{t('plans.assign_beneficiaries_hint')}</p>
          {familyLoading ? (
            <p style={{ ...cardHintStyle, marginBottom: 12 }}>{t('plans.assign_family_loading')}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              {family.map((m) => {
                const checked = selectedIds.includes(m.member_id);
                const blocked = !canSelectBeneficiary(selectedIds, m.member_id, plan.member_limit);
                return (
                  <label
                    key={m.member_id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(0,0,0,0.03)', borderRadius: 6, fontSize: 13, cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.6 : 1 }}
                  >
                    <input
                      type="checkbox"
                      role="switch"
                      checked={checked}
                      disabled={saving || blocked}
                      onChange={() => setSelectedIds((prev) => toggleBeneficiary(prev, m.member_id, plan.member_limit))}
                    />
                    <span style={{ fontWeight: 600 }}>{m.name}</span>
                    {m.email && <span style={{ color: '#888' }}>{m.email}</span>}
                    {m.member_id === ownerId && (
                      <span style={{ fontSize: 10, fontWeight: 600, color: '#6c63ff', background: '#eeecff', padding: '1px 6px', borderRadius: 3 }}>
                        {t('plans.assign_owner_badge')}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
          {!familyLoading && selectionIssue && (
            <p style={{ margin: '0 0 10px', fontSize: 12, color: '#b45309', background: '#fffbeb', padding: '6px 10px', borderRadius: 6 }}>
              ⚠ {issueText()}
            </p>
          )}
        </>
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
        <button onClick={() => handleSubmit()} disabled={saving || familyLoading || !subject || selectionIssue != null} style={primaryBtnSmall()}>
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
