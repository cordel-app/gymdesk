'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

/**
 * #67: the New Training Plan dialog shared by the Training Plans page and the
 * templates page's "Assign Plan to Member" shortcut (presetTemplate skips the
 * mode step). POSTs to /training-plans; a 409 means the member already has
 * Active plans, which swaps the footer for the keep-vs-expire prompt and the
 * chosen answer is retried as on_existing_active.
 */

interface TemplateOption { id: number; name: string }
interface MemberOption { id: number; name: string }
export interface CreatedPlan { id: number; member_id: number; name: string }

export function NewTrainingPlanDialog({ open, presetTemplate, onClose, onCreated }: {
  open: boolean;
  presetTemplate?: TemplateOption | null;
  onClose: () => void;
  onCreated: (plan: CreatedPlan) => void;
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
  // active-plan count from a 409 — non-null renders the keep-vs-expire prompt
  const [conflict, setConflict] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(presetTemplate ? 'template' : null);
    setTemplateId(presetTemplate ? String(presetTemplate.id) : '');
    setMemberId('');
    setName(presetTemplate?.name ?? '');
    setNameTouched(false);
    setStartDate(new Date().toISOString().slice(0, 10));
    setError(null);
    setConflict(null);
  }, [open, presetTemplate]);

  useEffect(() => {
    if (!open) return;
    apiFetch<MemberOption[]>('/members').then(setMembers).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open || mode !== 'template' || presetTemplate) return;
    apiFetch<{ items: TemplateOption[] }>('/training-plan-templates?status=active&limit=100')
      .then((res) => setTemplates(res.items))
      .catch(() => {});
  }, [open, mode, presetTemplate]);

  if (!open) return null;

  function pickTemplate(value: string) {
    setTemplateId(value);
    if (!nameTouched) {
      const tpl = templates.find((o) => String(o.id) === value);
      setName(tpl?.name ?? '');
    }
  }

  async function save(onExisting?: 'keep' | 'expire') {
    if (!memberId) { setError(t('training_plans.error_member_required')); return; }
    if (mode === 'template' && !templateId) { setError(t('training_plans.error_template_required')); return; }
    if (mode === 'scratch' && !name.trim()) { setError(t('training_plans.error_name_required')); return; }
    if (!startDate) { setError(t('training_plans.error_start_date_required')); return; }
    setSaving(true); setError(null);
    try {
      const plan = await apiFetch<CreatedPlan>('/training-plans', {
        method: 'POST',
        body: JSON.stringify({
          member_id: parseInt(memberId, 10),
          template_id: mode === 'template' ? parseInt(templateId, 10) : null,
          name: name.trim() || null,
          start_date: startDate,
          on_existing_active: onExisting ?? null,
        }),
      });
      onCreated(plan);
    } catch (err: any) {
      if (err.status === 409) setConflict(err.body?.active_count ?? 1);
      else setError(err.message ?? t('training_plans.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 16px' }}>{t('training_plans.new_plan')}</h2>

        {mode === null ? (
          <>
            <p style={{ margin: '0 0 16px', color: '#666', fontSize: 14 }}>{t('training_plans.new_plan_question')}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => setMode('template')} style={choiceStyle}>
                <span style={{ fontWeight: 600 }}>{t('training_plans.from_template')}</span>
                <span style={{ color: '#666', fontSize: 13 }}>{t('training_plans.from_template_hint')}</span>
              </button>
              <button onClick={() => setMode('scratch')} style={choiceStyle}>
                <span style={{ fontWeight: 600 }}>{t('training_plans.from_scratch')}</span>
                <span style={{ color: '#666', fontSize: 13 }}>{t('training_plans.from_scratch_hint')}</span>
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={onClose} style={btnStyle('#aaa')}>{t('training_plans.cancel')}</button>
            </div>
          </>
        ) : conflict !== null ? (
          <>
            <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.5 }}>
              {t('training_plans.conflict_message', { count: conflict })}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => save('keep')} disabled={saving} style={choiceStyle}>
                <span style={{ fontWeight: 600 }}>{t('training_plans.conflict_keep')}</span>
                <span style={{ color: '#666', fontSize: 13 }}>{t('training_plans.conflict_keep_hint')}</span>
              </button>
              <button onClick={() => save('expire')} disabled={saving} style={choiceStyle}>
                <span style={{ fontWeight: 600, color: '#b26a00' }}>{t('training_plans.conflict_expire')}</span>
                <span style={{ color: '#666', fontSize: 13 }}>{t('training_plans.conflict_expire_hint')}</span>
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setConflict(null)} style={btnStyle('#aaa')} disabled={saving}>{t('training_plans.cancel')}</button>
            </div>
          </>
        ) : (
          <>
            {mode === 'template' && (
              <>
                <FieldLabel>{t('training_plans.label_template')} *</FieldLabel>
                {presetTemplate ? (
                  <input value={presetTemplate.name} disabled style={{ ...inputStyle, background: '#f5f5f5', color: '#666' }} />
                ) : (
                  <select value={templateId} onChange={(e) => pickTemplate(e.target.value)} style={inputStyle} autoFocus>
                    <option value="">—</option>
                    {templates.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                )}
              </>
            )}

            <FieldLabel>{t('training_plans.label_member')} *</FieldLabel>
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)} style={inputStyle} autoFocus={mode === 'scratch'}>
              <option value="">—</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>

            <FieldLabel>{t('training_plans.label_name')}{mode === 'scratch' ? ' *' : ''}</FieldLabel>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
              style={inputStyle}
            />

            <FieldLabel>{t('training_plans.label_start_date')} *</FieldLabel>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />

            {error && <p style={{ color: '#c0392b', margin: '12px 0 0', fontSize: 14 }}>{error}</p>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button onClick={onClose} style={btnStyle('#aaa')} disabled={saving}>{t('training_plans.cancel')}</button>
              <button onClick={() => save()} style={btnStyle()} disabled={saving}>
                {saving ? t('training_plans.saving') : t('training_plans.create')}
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
