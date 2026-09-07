'use client';

import { useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

interface Membership {
  id: number;
  plan_name: string | null;
}

interface Plan {
  id: number;
  name: string;
}

interface Props {
  membership: Membership;
  plans: Plan[];
  onClose: () => void;
  onAssigned: () => void;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function AssignNewPlanModal({ membership, plans, onClose, onAssigned }: Props) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();

  const [planId, setPlanId] = useState('');
  const [startsAt, setStartsAt] = useState(todayISO());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px', fontSize: 17 }}>{t('members.assign_new_plan_title')}</h3>
        {membership.plan_name && (
          <p style={{ margin: '0 0 16px', fontSize: 13, color: '#888' }}>{membership.plan_name}</p>
        )}

        <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>{t('members.assign_new_plan_label_plan')}</label>
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

        <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>{t('members.assign_new_plan_label_starts')}</label>
        <input
          type="date"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          disabled={saving}
          style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, margin: '6px 0 12px' }}
        />

        {error && <p style={{ color: '#c0392b', fontSize: 13, margin: '0 0 12px' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnStyle('#aaa')} disabled={saving}>{t('members.cancel')}</button>
          <button onClick={handleSubmit} style={btnStyle('#6c63ff')} disabled={saving}>
            {saving ? t('members.saving') : t('members.assign_new_plan_submit')}
          </button>
        </div>
      </div>
    </div>
  );
}

const selectStyle: CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box', background: '#fff',
  margin: '6px 0 12px',
};
