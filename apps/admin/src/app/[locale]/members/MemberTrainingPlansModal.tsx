'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { StatusBadge } from '@/components/StatusBadge';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';
import { TrainingPlanEditorModal } from './TrainingPlanEditorModal';

interface TemplateOption { id: number; name: string; status: string }
interface Assignment {
  id: number; training_plan_id: number; training_plan_name: string; status: 'active' | 'completed' | 'cancelled';
  valid_from: string | null; valid_to: string | null; created_at: string;
}

type AssignMode = 'template' | 'scratch';

export function MemberTrainingPlansModal({ memberId, memberName, onClose }: { memberId: number; memberName: string; onClose: () => void }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<AssignMode>('template');
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingPlan, setEditingPlan] = useState<Assignment | null>(null);

  const base = `/members/${memberId}/member-training-plans`;

  async function load() {
    setLoading(true);
    try {
      const [as, tpls] = await Promise.all([
        apiFetch<Assignment[]>(base),
        apiFetch<TemplateOption[]>('/training-plan-templates?status=active'),
      ]);
      setAssignments(as); setTemplates(tpls);
    } catch (err: any) { toast(err.message ?? t('member_training_plans.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [memberId]);

  async function assign() {
    if (mode === 'template' && !templateId) { setError(t('member_training_plans.error_no_template')); return; }
    if (mode === 'scratch' && !name.trim()) { setError(t('member_training_plans.error_required')); return; }
    setSaving(true); setError(null);
    const body: any = mode === 'template'
      ? { template_id: parseInt(templateId, 10) }
      : { name: name.trim(), description: description.trim() || null };
    try {
      await apiFetch(base, { method: 'POST', body: JSON.stringify(body) });
      setTemplateId(''); setName(''); setDescription('');
      load();
    } catch (err: any) { setError(err.message ?? t('member_training_plans.error_generic')); }
    finally { setSaving(false); }
  }

  async function setStatus(a: Assignment, status: 'completed' | 'cancelled') {
    try { await apiFetch(`${base}/${a.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); load(); }
    catch (err: any) { toast(err.message ?? t('member_training_plans.error_generic')); }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 720 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('member_training_plans.title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{memberName}</p>

        {loading ? (
          <p style={{ color: '#666' }}>{t('member_training_plans.loading')}</p>
        ) : assignments.length === 0 ? (
          <p style={{ color: '#666' }}>{t('member_training_plans.empty')}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                <th style={th}>{t('member_training_plans.col_plan')}</th>
                <th style={th}>{t('member_training_plans.col_status')}</th>
                <th style={th}>{t('member_training_plans.col_valid_from')}</th>
                <th style={th}>{t('member_training_plans.col_valid_to')}</th>
                <th style={{ ...th, width: 220 }} />
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id} style={{ borderBottom: '1px solid #f4f4f4' }}>
                  <td style={td}>{a.training_plan_name}</td>
                  <td style={td}><StatusBadge status={a.status} label={t(`member_training_plans.status_${a.status}`)} /></td>
                  <td style={td}>{a.valid_from ?? '—'}</td>
                  <td style={td}>{a.valid_to ?? '—'}</td>
                  <td style={{ ...td, display: 'flex', gap: 6 }}>
                    <button onClick={() => setEditingPlan(a)} style={btnSmall('#1e7e40')}>{t('member_training_plans.view_edit')}</button>
                    {a.status === 'active' && (
                      <>
                        <button onClick={() => setStatus(a, 'completed')} style={btnSmall('#444')}>{t('member_training_plans.mark_completed')}</button>
                        <button onClick={() => setStatus(a, 'cancelled')} style={btnSmall('#c0392b')}>{t('member_training_plans.mark_cancelled')}</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ borderTop: '1px solid #eee', paddingTop: 16 }}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 14 }}>{t('member_training_plans.assign_heading')}</p>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
            <label style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" checked={mode === 'template'} onChange={() => setMode('template')} /> {t('member_training_plans.from_template')}
            </label>
            <label style={{ fontSize: 14, display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" checked={mode === 'scratch'} onChange={() => setMode('scratch')} /> {t('member_training_plans.from_scratch')}
            </label>
          </div>

          {mode === 'template' ? (
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={{ ...input, width: 280 }}>
              <option value="">—</option>
              {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
            </select>
          ) : (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('member_training_plans.label_name')} style={{ ...input, width: 220 }} />
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('member_training_plans.label_description')} style={{ ...input, width: 280 }} />
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <button onClick={assign} style={btnStyle('#6c63ff')} disabled={saving}>
              {saving ? t('member_training_plans.saving') : t('member_training_plans.assign')}
            </button>
          </div>
          {error && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('member_training_plans.close')}</button>
        </div>

        {editingPlan && (
          <TrainingPlanEditorModal
            memberId={memberId}
            planId={editingPlan.training_plan_id}
            planName={editingPlan.training_plan_name}
            onClose={() => setEditingPlan(null)}
          />
        )}
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: '8px 10px', fontSize: 13, fontWeight: 600, color: '#555' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 14 };
const input: React.CSSProperties = { padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box' };
