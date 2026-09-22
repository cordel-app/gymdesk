'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';

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

  const isStackable = (p: Promotion) => !!p.stackable;
  const selected = promotions.filter((p) => selectedPromotionIds.includes(p.id));
  const nonStackableSelected = selected.some((p) => !isStackable(p));

  function disabledReason(p: Promotion): string | null {
    if (selectedPromotionIds.includes(p.id)) return null;
    if (nonStackableSelected) return t('members.assign_new_plan_promotion_blocked_by_non_stackable');
    if (selected.length > 0 && !isStackable(p)) return t('members.assign_new_plan_promotion_blocked_non_stackable');
    return null;
  }

  function togglePromotion(p: Promotion) {
    setSelectedPromotionIds((prev) =>
      prev.includes(p.id) ? prev.filter((id) => id !== p.id) : [...prev, p.id],
    );
  }

  async function handleSubmit() {
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
        }),
      });
      onAssigned();
    } catch (err: any) {
      setError(err.message ?? t('members.assign_new_plan_error_generic'));
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {promotions.map((p) => {
            const checked = selectedPromotionIds.includes(p.id);
            const blocked = disabledReason(p);
            return (
              <label
                key={p.id}
                title={blocked ?? undefined}
                style={promotionRowStyle(checked, blocked !== null)}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={saving || blocked !== null}
                  onChange={() => togglePromotion(p)}
                  style={{ marginRight: 8 }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>{p.name}</span>
                <span style={stackTagStyle(isStackable(p))}>
                  {isStackable(p)
                    ? t('members.assign_new_plan_promotion_stackable')
                    : t('members.assign_new_plan_promotion_non_stackable')}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {error && <p style={{ color: '#c0392b', fontSize: 13, margin: '0 0 10px' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleSubmit} disabled={saving} style={saveBtnStyle}>
          {saving ? t('members.saving') : t('members.assign_new_plan_submit')}
        </button>
        <button onClick={onCancel} disabled={saving} style={cancelBtnStyle}>
          {t('members.cancel')}
        </button>
      </div>
    </div>
  );
}

const editorStyle: CSSProperties = {
  background: '#f8f8fb', border: '1px solid #e8e8ed', borderRadius: 6,
  padding: '12px 14px', marginTop: 10,
};
const editorTitleStyle: CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 2 };
const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block' };
const selectStyle: CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box', background: '#fff',
  margin: '6px 0 12px',
};
const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #d1d5db', fontSize: 13, margin: '6px 0 12px',
};
const sectionLabelStyle: CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase',
  letterSpacing: '0.07em', marginBottom: 8,
};
const hintStyle: CSSProperties = { color: '#888', fontSize: 13, margin: '0 0 12px' };

function promotionRowStyle(checked: boolean, disabled: boolean): CSSProperties {
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

function stackTagStyle(stackable: boolean): CSSProperties {
  return {
    fontSize: 11, fontWeight: 600, color: stackable ? '#15803d' : '#b45309',
    background: stackable ? '#f0fdf4' : '#fffbeb',
    border: `1px solid ${stackable ? '#bbf7d0' : '#fde68a'}`,
    borderRadius: 10, padding: '1px 8px', flexShrink: 0,
  };
}

const saveBtnStyle: CSSProperties = {
  background: '#6c63ff', color: '#fff', border: 'none', borderRadius: 4,
  padding: '6px 14px', fontSize: 13, cursor: 'pointer',
};
const cancelBtnStyle: CSSProperties = {
  background: 'none', border: '1px solid #d0d0d0', borderRadius: 4,
  padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: '#444',
};
