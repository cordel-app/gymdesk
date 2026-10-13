'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { activePlanConflict, type ActivePlanConflict } from '@/lib/activePlanConflict';
import { ReplacePlanDialog } from '@/components/ReplacePlanDialog';
import {
  cardHintStyle,
  cardSectionLabelStyle,
  formControlStyle,
  formFieldLabelStyle,
  inlineEditorStyle,
  inlineEditorTitleStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import { PromotionPicker, type PickerPromotion } from '@/components/PromotionPicker';
import { promotionBenefitDescription } from '@/lib/promotionSelection';

interface Membership {
  id: number;
  plan_name: string | null;
}

interface Plan {
  id: number;
  name: string;
}

// `stackable` comes back as MySQL's TINYINT(1), i.e. 0/1 over JSON.
interface Promotion {
  id: number;
  name: string;
  stackable: boolean | number;
  fee_benefit_action?: string | null;
  fee_benefit_value?: number | string | null;
  fee_benefit_duration_months?: number | null;
}

interface Props {
  membership: Membership;
  plans: Plan[];
  onCancel: () => void;
  onAssigned: () => void;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * #628: Assign New Plan, inline. Replaces the former `AssignNewPlanModal` —
 * the whole assignment (plan, start date and the Promotions to apply with it)
 * is configured in place inside the member's expanded row, following the
 * inline editing pattern used everywhere else in the admin app.
 *
 * The Promotions section enforces the `stackable` rule as the selection
 * changes, so an invalid combination can't even be built:
 *   - a selected non-stackable promotion disables every other promotion;
 *   - any selected promotion disables the non-stackable ones;
 *   - clearing the selection re-enables everything.
 * The same rule is re-validated server-side (`validatePromotionSelection`) —
 * this is a UX affordance, not the enforcement point.
 *
 * #956: replacing the plan named in the URL is this editor's whole purpose, so
 * it needs no confirmation of its own — but a Member *additionally* covered by
 * another live assignment (a family plan somebody else owns) does, because
 * cancelling that one takes it away from every member it covers. The server
 * answers `409 active_plan_exists` for exactly that case and the shared
 * `ReplacePlanDialog` is what the admin confirms it in.
 */
export function AssignPlanInlineEditor({ membership, plans, onCancel, onAssigned }: Props) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();

  const [planId, setPlanId] = useState('');
  const [startsAt, setStartsAt] = useState(todayISO());
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [promotionsLoading, setPromotionsLoading] = useState(false);
  const [selectedPromotionIds, setSelectedPromotionIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ActivePlanConflict | null>(null);

  // Eligible promotions are scoped to the plan being assigned — the apply path
  // rejects a promotion that doesn't target it, so offering the others would
  // only produce a 400 after Save.
  useEffect(() => {
    setSelectedPromotionIds([]);
    if (!planId) { setPromotions([]); return; }

    let cancelled = false;
    setPromotionsLoading(true);
    apiFetch<Promotion[]>(
      `/promotions?lifecycle_status=active&active_on=${todayISO()}&membership_plan_id=${planId}`,
    )
      .then((rows) => { if (!cancelled) setPromotions(rows); })
      .catch(() => { if (!cancelled) setPromotions([]); })
      .finally(() => { if (!cancelled) setPromotionsLoading(false); });

    return () => { cancelled = true; };
  }, [planId]);

  // #1539: the shared picker owns the stacking rule and the description; the
  // description is generated from the Promotion's Membership Fee Benefit.
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
    };
  });

  async function handleSubmit(confirmReplacement = false) {
    setError(null);
    if (!planId) { setError(t('members.assign_new_plan_error_no_plan')); return; }
    if (!startsAt) { setError(t('members.assign_new_plan_error_no_start')); return; }

    setSaving(true);
    try {
      await apiFetch(`/user-memberships/${membership.id}/assign-new-plan`, {
        method: 'POST',
        body: JSON.stringify({
          membership_plan_id: parseInt(planId, 10),
          starts_at: startsAt,
          promotion_ids: selectedPromotionIds,
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
        setError(apiErrorMessage(err) ?? t('members.assign_new_plan_error_generic'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={editorStyle}>
      <div style={editorTitleStyle}>{t('members.assign_new_plan_title')}</div>
      {membership.plan_name && (
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#888' }}>{membership.plan_name}</p>
      )}

      <label style={labelStyle}>{t('members.assign_new_plan_label_plan')}</label>
      <select
        value={planId}
        onChange={(e) => setPlanId(e.target.value)}
        disabled={saving}
        style={selectStyle}
      >
        <option value="">{t('members.assign_new_plan_pick_plan')}</option>
        {plans.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>

      <label style={labelStyle}>{t('members.assign_new_plan_label_starts')}</label>
      <input
        type="date"
        value={startsAt}
        onChange={(e) => setStartsAt(e.target.value)}
        disabled={saving}
        style={inputStyle}
      />

      <div style={{ ...sectionLabelStyle, marginTop: 6 }}>{t('members.assign_new_plan_section_promotions')}</div>
      {!planId ? (
        <p style={hintStyle}>{t('members.assign_new_plan_promotions_pick_plan')}</p>
      ) : promotionsLoading ? (
        <p style={hintStyle}>{t('members.assign_new_plan_promotions_loading')}</p>
      ) : promotions.length === 0 ? (
        <p style={hintStyle}>{t('members.assign_new_plan_promotions_none')}</p>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <PromotionPicker
            promotions={pickerPromotions}
            selectedIds={selectedPromotionIds}
            onToggle={(id) => setSelectedPromotionIds((prev) => (
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
            ))}
            disabled={saving}
            emptyText={t('members.assign_new_plan_promotions_none')}
          />
        </div>
      )}

      {error && <p style={{ color: '#c0392b', fontSize: 13, margin: '0 0 10px' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => handleSubmit()} disabled={saving} style={saveBtnStyle}>
          {saving ? t('members.saving') : t('members.assign_new_plan_submit')}
        </button>
        <button onClick={onCancel} disabled={saving} style={cancelBtnStyle}>
          {t('members.cancel')}
        </button>
      </div>

      <ReplacePlanDialog
        conflict={conflict}
        newPlanName={plans.find((p) => String(p.id) === planId)?.name ?? null}
        busy={saving}
        onConfirm={() => handleSubmit(true)}
        onCancel={() => setConflict(null)}
      />
    </div>
  );
}

// #929: the look is `components/formChrome.ts` — one editor box, one field
// label, one control, one section header, shared with the card this opens in.
const editorStyle: CSSProperties = { ...inlineEditorStyle, marginTop: 10 };
const editorTitleStyle: CSSProperties = { ...inlineEditorTitleStyle, marginBottom: 2 };
const labelStyle = formFieldLabelStyle;
const selectStyle: CSSProperties = { ...formControlStyle, margin: '6px 0 12px' };
const inputStyle: CSSProperties = { ...formControlStyle, margin: '6px 0 12px' };
const sectionLabelStyle = cardSectionLabelStyle;
const hintStyle = cardHintStyle;

const saveBtnStyle = primaryBtnSmall();
const cancelBtnStyle = secondaryBtnSmall;
