'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

/**
 * #443: the "+ New Nutrition Plan" dialog, mirroring #67's
 * NewTrainingPlanDialog.tsx — a scratch-vs-template mode choice, then a form.
 * POSTs to /member-nutrition-plans.
 */

interface TemplateOption { id: number; name: string }
interface MemberOption { id: number; name: string }
export interface CreatedNutritionPlan { id: number; member_id: number; name: string }

export function NewNutritionPlanDialog({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (plan: CreatedNutritionPlan) => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();

  const [mode, setMode] = useState<'template' | 'scratch' | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [memberId, setMemberId] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(null);
    setTemplateId('');
    setMemberId('');
    setName('');
    setNameTouched(false);
    setStartDate(new Date().toISOString().slice(0, 10));
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    apiFetch<MemberOption[]>('/members').then(setMembers).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open || mode !== 'template') return;
    apiFetch<{ items: TemplateOption[] }>('/nutrition-plan-templates?status=active&limit=100')
      .then((res) => setTemplates(res.items))
      .catch(() => {});
  }, [open, mode]);

  if (!open) return null;

  function pickTemplate(value: string) {
    setTemplateId(value);
    if (!nameTouched) {
      const tpl = templates.find((o) => String(o.id) === value);
      setName(tpl?.name ?? '');
    }
  }

  async function save() {
    if (!memberId) { setError(t('nutrition_plans.error_member_required')); return; }
    if (mode === 'template' && !templateId) { setError(t('nutrition_plans.error_template_required')); return; }
    if (mode === 'scratch' && !name.trim()) { setError(t('nutrition_plans.error_name_required')); return; }
    if (!startDate) { setError(t('nutrition_plans.error_start_date_required')); return; }
    setSaving(true); setError(null);
    try {
      const plan = await apiFetch<CreatedNutritionPlan>('/member-nutrition-plans', {
        method: 'POST',
        body: JSON.stringify({
          member_id: parseInt(memberId, 10),
          template_id: mode === 'template' ? parseInt(templateId, 10) : null,
          name: name.trim() || null,
          start_date: startDate,
        }),
      });
      onCreated(plan);
    } catch (err: any) {
      setError(err.message ?? t('nutrition_plans.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 16px' }}>{t('nutrition_plans.new_plan')}</h2>

        {mode === null ? (
          <>
            <p style={{ margin: '0 0 16px', color: '#666', fontSize: 14 }}>{t('nutrition_plans.new_plan_question')}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => setMode('template')} style={choiceStyle}>
                <span style={{ fontWeight: 600 }}>{t('nutrition_plans.from_template')}</span>
                <span style={{ color: '#666', fontSize: 13 }}>{t('nutrition_plans.from_template_hint')}</span>
              </button>
              <button onClick={() => setMode('scratch')} style={choiceStyle}>
                <span style={{ fontWeight: 600 }}>{t('nutrition_plans.from_scratch')}</span>
                <span style={{ color: '#666', fontSize: 13 }}>{t('nutrition_plans.from_scratch_hint')}</span>
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={onClose} style={btnStyle('#aaa')}>{t('nutrition_plans.cancel')}</button>
            </div>
          </>
        ) : (
          <>
            {mode === 'template' && (
              <>
                <FieldLabel>{t('nutrition_plans.label_template')} *</FieldLabel>
                <select value={templateId} onChange={(e) => pickTemplate(e.target.value)} style={inputStyle} autoFocus>
                  <option value="">—</option>
                  {templates.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </>
            )}

            <FieldLabel>{t('nutrition_plans.label_member')} *</FieldLabel>
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)} style={inputStyle} autoFocus={mode === 'scratch'}>
              <option value="">—</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>

            <FieldLabel>{t('nutrition_plans.label_name')}{mode === 'scratch' ? ' *' : ''}</FieldLabel>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
              style={inputStyle}
            />

            <FieldLabel>{t('nutrition_plans.label_start_date')} *</FieldLabel>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />

            {error && <p style={{ color: '#c0392b', margin: '12px 0 0', fontSize: 14 }}>{error}</p>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button onClick={onClose} style={btnStyle('#aaa')} disabled={saving}>{t('nutrition_plans.cancel')}</button>
              <button onClick={() => save()} style={btnStyle()} disabled={saving}>
                {saving ? t('nutrition_plans.saving') : t('nutrition_plans.create')}
              </button>
            </div>
          </>
        )}
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
const choiceStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
  padding: '14px 16px', borderRadius: 8, border: '1px solid #ddd', background: '#fff',
  cursor: 'pointer', textAlign: 'left', font: 'inherit',
};
