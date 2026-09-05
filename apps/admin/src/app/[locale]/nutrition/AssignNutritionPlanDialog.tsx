'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

interface TemplateOption { id: number; name: string }
interface MemberOption { id: number; name: string }
export interface AssignedNutritionPlan { id: number; member_id: number; name: string }

export function AssignNutritionPlanDialog({ open, template, onClose, onAssigned }: {
  open: boolean;
  template: TemplateOption | null;
  onClose: () => void;
  onAssigned: (plan: AssignedNutritionPlan) => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();

  const [members, setMembers] = useState<MemberOption[]>([]);
  const [memberId, setMemberId] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMemberId('');
    setName(template?.name ?? '');
    setError(null);
    setSaving(false);
  }, [open, template]);

  useEffect(() => {
    if (!open) return;
    apiFetch<MemberOption[]>('/members').then(setMembers).catch(() => {});
  }, [open]);

  if (!open || !template) return null;

  async function save() {
    if (!memberId) { setError(t('nutrition_plans.error_member_required')); return; }
    if (!name.trim()) { setError(t('nutrition_plans.error_name_required')); return; }
    setSaving(true); setError(null);
    try {
      const plan = await apiFetch<AssignedNutritionPlan>(`/nutrition-plan-templates/${template!.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ member_id: parseInt(memberId, 10), name: name.trim() }),
      });
      onAssigned(plan);
    } catch (err: any) {
      setError(err.message ?? t('nutrition_plans.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 16px' }}>{t('nutrition_plans.assign_title')}</h2>

        <FieldLabel>{t('nutrition_plans.label_template')}</FieldLabel>
        <input value={template.name} disabled style={{ ...inputStyle, background: '#f5f5f5', color: '#666' }} />

        <FieldLabel>{t('nutrition_plans.label_member')} *</FieldLabel>
        <select value={memberId} onChange={(e) => setMemberId(e.target.value)} style={inputStyle} autoFocus>
          <option value="">—</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>

        <FieldLabel>{t('nutrition_plans.label_name')} *</FieldLabel>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={inputStyle}
        />

        {error && <p style={{ color: '#c0392b', margin: '12px 0 0', fontSize: 14 }}>{error}</p>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button onClick={onClose} style={btnStyle('#aaa')} disabled={saving}>{t('nutrition_plans.cancel')}</button>
          <button onClick={save} style={btnStyle()} disabled={saving}>
            {saving ? t('nutrition_plans.saving') : t('nutrition_plans.assign')}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 600, color: '#555', margin: '12px 0 6px' }}>{children}</div>;
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 15, boxSizing: 'border-box', background: '#fff',
};
