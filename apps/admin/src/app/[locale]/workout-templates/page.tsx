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
import { DependencyDialog, ReferenceReport } from '@/components/DependencyDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { btnStyle, btnSmall } from '@/components/ui';
import { WorkoutTemplateBlocksModal } from './WorkoutTemplateBlocksModal';

export interface WorkoutTemplate { id: number; name: string; description: string | null; status: 'active' | 'inactive' }

const STATUSES = ['active', 'inactive'];
const emptyForm = { name: '', description: '', status: 'active' };
const selectStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' };

export default function WorkoutTemplatesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<WorkoutTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkoutTemplate | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WorkoutTemplate | null>(null);
  const [blocksFor, setBlocksFor] = useState<WorkoutTemplate | null>(null);
  const [depDialog, setDepDialog] = useState<{ action: 'edit' | 'delete'; entity: WorkoutTemplate; refs: ReferenceReport } | null>(null);
  const [checkingDeps, setCheckingDeps] = useState(false);
  const [depBusy, setDepBusy] = useState(false);

  const canWrite = isSuperadmin || activeGym?.role === 'admin' || activeGym?.role === 'coach';
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setRows(await apiFetch<WorkoutTemplate[]>('/workout-templates'));
    } catch (err: any) { toast(err.message ?? t('workout_templates.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  function openAdd() { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }
  function openEdit(w: WorkoutTemplate) {
    setEditing(w);
    setForm({ name: w.name, description: w.description ?? '', status: w.status });
    setError(null); setModalOpen(true);
  }

  /** #62: check dependencies before edit/delete; warn only when some exist. */
  async function guardedAction(action: 'edit' | 'delete', w: WorkoutTemplate) {
    if (checkingDeps) return;
    setCheckingDeps(true);
    try {
      const refs = await apiFetch<ReferenceReport>(`/workout-templates/${w.id}/references`);
      if (refs.usageCount > 0) { setDepDialog({ action, entity: w, refs }); return; }
      if (action === 'edit') openEdit(w);
      else setDeleting(w);
    } catch (err: any) {
      toast(err.message ?? t('workout_templates.error_generic'));
    } finally { setCheckingDeps(false); }
  }

  async function depContinue() {
    if (!depDialog) return;
    if (depDialog.action === 'edit') {
      openEdit(depDialog.entity);
      setDepDialog(null);
      return;
    }
    setDepBusy(true);
    try {
      await apiFetch(`/workout-templates/${depDialog.entity.id}`, { method: 'DELETE' });
      setDepDialog(null); load();
    } catch (err: any) { setDepDialog(null); toast(err.message ?? t('workout_templates.error_generic')); }
    finally { setDepBusy(false); }
  }

  async function save() {
    if (!form.name.trim()) { setError(t('workout_templates.error_required')); return; }
    setSaving(true); setError(null);
    const body = { name: form.name.trim(), description: form.description.trim() || null, status: form.status };
    try {
      if (editing) await apiFetch(`/workout-templates/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/workout-templates', { method: 'POST', body: JSON.stringify(body) });
      setModalOpen(false); setEditing(null); setForm(emptyForm); load();
    } catch (err: any) { setError(err.message ?? t('workout_templates.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`/workout-templates/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('workout_templates.error_generic')); }
  }

  if (gymLoading || !canWrite) return null;

  const columns: Column<WorkoutTemplate>[] = [
    { header: t('workout_templates.col_name'), render: (w) => w.name },
    { header: t('workout_templates.col_description'), render: (w) => w.description ?? '—' },
    { header: t('workout_templates.col_status'), width: 110, render: (w) => <StatusBadge status={w.status} label={t(`status.${w.status}`)} /> },
    {
      header: t('workout_templates.col_actions'), width: 260,
      render: (w) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setBlocksFor(w)} style={btnSmall('#6c63ff')}>{t('workout_templates.blocks')}</button>
          <button onClick={() => guardedAction('edit', w)} style={btnSmall('#444')}>{t('workout_templates.edit')}</button>
          <button onClick={() => guardedAction('delete', w)} style={btnSmall('#c0392b')}>{t('workout_templates.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('workout_templates.title')}</h1>
        <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('workout_templates.add')}</button>
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading}
                 loadingText={t('workout_templates.loading')} emptyText={t('workout_templates.empty')} />

      <CrudModal
        open={modalOpen}
        title={editing ? t('workout_templates.modal_edit') : t('workout_templates.modal_add')}
        error={error} saving={saving}
        cancelLabel={t('workout_templates.cancel')}
        saveLabel={saving ? t('workout_templates.saving') : editing ? t('workout_templates.save_changes') : t('workout_templates.modal_add')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }}
        onSave={save}
      >
        <FormLabel>{t('workout_templates.label_name')} *</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        <FormLabel>{t('workout_templates.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormLabel>{t('workout_templates.label_status')}</FormLabel>
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} style={selectStyle}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog open={deleting !== null} message={t('workout_templates.confirm_delete')}
                     confirmLabel={t('workout_templates.delete')} cancelLabel={t('workout_templates.cancel')}
                     onConfirm={del} onCancel={() => setDeleting(null)} />

      <DependencyDialog
        open={depDialog !== null}
        message={depDialog ? t(`dependencies.workout_template_${depDialog.action}`, { name: depDialog.entity.name, count: depDialog.refs.usageCount }) : ''}
        question={t('dependencies.question')}
        references={depDialog?.refs.references ?? []}
        moreLabel={depDialog && depDialog.refs.usageCount > depDialog.refs.references.length
          ? t('dependencies.more', { n: depDialog.refs.usageCount - depDialog.refs.references.length }) : null}
        referenceHref={`/${locale}/training-plan-templates`}
        confirmLabel={t('dependencies.continue')}
        cancelLabel={t('dependencies.cancel')}
        onConfirm={depContinue}
        onCancel={() => setDepDialog(null)}
        busy={depBusy}
      />

      {blocksFor && (
        <WorkoutTemplateBlocksModal workoutTemplateId={blocksFor.id} workoutTemplateName={blocksFor.name} onClose={() => setBlocksFor(null)} />
      )}
    </div>
  );
}
