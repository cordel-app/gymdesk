'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall } from '@/components/ui';
import { TemplateWorkoutsModal } from './TemplateWorkoutsModal';

export interface TrainingPlanTemplate { id: number; name: string; description: string | null; status: 'active' | 'inactive' | 'draft' }

const STATUSES = ['active', 'inactive', 'draft'] as const;
const emptyForm = { name: '', description: '', status: 'active' };

export default function TrainingPlanTemplatesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<TrainingPlanTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TrainingPlanTemplate | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TrainingPlanTemplate | null>(null);
  const [workoutsFor, setWorkoutsFor] = useState<TrainingPlanTemplate | null>(null);

  const canWrite = isSuperadmin || activeGym?.role === 'admin' || activeGym?.role === 'coach';
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setRows(await apiFetch<TrainingPlanTemplate[]>(`/training-plan-templates${statusFilter ? `?status=${statusFilter}` : ''}`));
    } catch (err: any) { toast(err.message ?? t('training_plan_templates.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

  function openAdd() { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }
  function openEdit(w: TrainingPlanTemplate) {
    setEditing(w);
    setForm({ name: w.name, description: w.description ?? '', status: w.status });
    setError(null); setModalOpen(true);
  }

  async function save() {
    if (!form.name.trim()) { setError(t('training_plan_templates.error_required')); return; }
    setSaving(true); setError(null);
    const body = { name: form.name.trim(), description: form.description.trim() || null, status: form.status };
    try {
      if (editing) await apiFetch(`/training-plan-templates/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/training-plan-templates', { method: 'POST', body: JSON.stringify(body) });
      setModalOpen(false); setEditing(null); setForm(emptyForm); load();
    } catch (err: any) { setError(err.message ?? t('training_plan_templates.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`/training-plan-templates/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('training_plan_templates.error_generic')); }
  }

  if (gymLoading || !canWrite) return null;

  const columns: Column<TrainingPlanTemplate>[] = [
    { header: t('training_plan_templates.col_name'), render: (w) => w.name },
    { header: t('training_plan_templates.col_status'), width: 110, render: (w) => <StatusBadge status={w.status} label={t(`status.${w.status}`)} /> },
    {
      header: t('training_plan_templates.col_actions'), width: 260,
      render: (w) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setWorkoutsFor(w)} style={btnSmall('#6c63ff')}>{t('training_plan_templates.workouts')}</button>
          <button onClick={() => openEdit(w)} style={btnSmall('#444')}>{t('training_plan_templates.edit')}</button>
          <button onClick={() => setDeleting(w)} style={btnSmall('#c0392b')}>{t('training_plan_templates.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('training_plan_templates.title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('training_plan_templates.add')}</button>
        </div>
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading}
                 loadingText={t('training_plan_templates.loading')} emptyText={t('training_plan_templates.empty')} />

      <CrudModal
        open={modalOpen}
        title={editing ? t('training_plan_templates.modal_edit') : t('training_plan_templates.modal_add')}
        error={error} saving={saving}
        cancelLabel={t('training_plan_templates.cancel')}
        saveLabel={saving ? t('training_plan_templates.saving') : editing ? t('training_plan_templates.save_changes') : t('training_plan_templates.modal_add')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }}
        onSave={save}
      >
        <FormLabel>{t('training_plan_templates.label_name')} *</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        <FormLabel>{t('training_plan_templates.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormLabel>{t('training_plan_templates.label_status')}</FormLabel>
        <select
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value })}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}
        >
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog open={deleting !== null} message={t('training_plan_templates.confirm_delete')}
                     confirmLabel={t('training_plan_templates.delete')} cancelLabel={t('training_plan_templates.cancel')}
                     onConfirm={del} onCancel={() => setDeleting(null)} />

      {workoutsFor && (
        <TemplateWorkoutsModal templateId={workoutsFor.id} templateName={workoutsFor.name} onClose={() => setWorkoutsFor(null)} />
      )}
    </div>
  );
}
