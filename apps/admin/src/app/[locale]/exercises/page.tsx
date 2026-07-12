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
import { btnStyle, btnSmall } from '@/components/ui';

interface Muscle { id: number; name: string }
interface Exercise {
  id: number; name: string; description: string | null;
  video_url: string | null; image_url: string | null;
  default_reps: string | null; default_rest_seconds: number | null;
  status: 'active' | 'inactive';
  muscles: { id: number; name: string; role: 'principal' | 'secondary' }[] | null;
}

const emptyForm = { name: '', description: '', video_url: '', image_url: '', default_reps: '', default_rest_seconds: '', status: 'active' };

export default function ExercisesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Exercise[]>([]);
  const [muscles, setMuscles] = useState<Muscle[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Exercise | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [selectedMuscles, setSelectedMuscles] = useState<Map<number, 'principal' | 'secondary'>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Exercise | null>(null);
  const [importing, setImporting] = useState(false);

  const canWrite = isSuperadmin || activeGym?.role === 'admin' || activeGym?.role === 'coach';
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [ex, mu] = await Promise.all([
        apiFetch<Exercise[]>('/exercises'),
        apiFetch<Muscle[]>('/muscles'),
      ]);
      setRows(ex); setMuscles(mu);
    } catch (err: any) { toast(err.message ?? t('exercises.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  async function importDefaults() {
    setImporting(true);
    try {
      const result: any = await apiFetch('/exercises/import-defaults', { method: 'POST' });
      toast(t('exercises.imported', { n: result.inserted }));
      load();
    } catch (err: any) { toast(err.message ?? t('exercises.error_generic')); }
    finally { setImporting(false); }
  }

  function openAdd() {
    setEditing(null); setForm(emptyForm); setSelectedMuscles(new Map()); setError(null); setModalOpen(true);
  }
  function openEdit(e: Exercise) {
    setEditing(e);
    setForm({
      name: e.name, description: e.description ?? '',
      video_url: e.video_url ?? '', image_url: e.image_url ?? '',
      default_reps: e.default_reps ?? '',
      default_rest_seconds: e.default_rest_seconds ? String(e.default_rest_seconds) : '',
      status: e.status,
    });
    const map = new Map<number, 'principal' | 'secondary'>();
    for (const m of (e.muscles ?? [])) map.set(m.id, m.role);
    setSelectedMuscles(map);
    setError(null); setModalOpen(true);
  }

  async function save() {
    if (!form.name.trim()) { setError(t('exercises.error_required')); return; }
    setSaving(true); setError(null);
    const body: any = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      video_url: form.video_url.trim() || null,
      image_url: form.image_url.trim() || null,
      default_reps: form.default_reps.trim() || null,
      default_rest_seconds: form.default_rest_seconds ? parseInt(form.default_rest_seconds, 10) : null,
      status: form.status,
      muscle_ids: Array.from(selectedMuscles.entries()).map(([id, role]) => ({ id, role })),
    };
    try {
      if (editing) await apiFetch(`/exercises/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/exercises', { method: 'POST', body: JSON.stringify(body) });
      setModalOpen(false); setEditing(null); setForm(emptyForm); load();
    } catch (err: any) { setError(err.message ?? t('exercises.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`/exercises/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('exercises.error_generic')); }
  }

  if (gymLoading || !canWrite) return null;

  const columns: Column<Exercise>[] = [
    { header: t('exercises.col_name'), render: (e) => e.name },
    { header: t('exercises.col_muscles'), render: (e) => (e.muscles ?? []).map((m) => `${m.name}${m.role === 'secondary' ? ' (2°)' : ''}`).join(', ') || '—' },
    { header: t('exercises.col_defaults'), width: 140, render: (e) => `${e.default_reps ?? '—'} · ${e.default_rest_seconds ?? '—'}s` },
    { header: t('exercises.col_status'), width: 110, render: (e) => <StatusBadge status={e.status} label={t(`status.${e.status}`)} /> },
    {
      header: t('exercises.col_actions'), width: 180,
      render: (e) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => openEdit(e)} style={btnSmall('#444')}>{t('exercises.edit')}</button>
          <button onClick={() => setDeleting(e)} style={btnSmall('#c0392b')}>{t('exercises.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('exercises.title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={importDefaults} disabled={importing} style={btnStyle('#1e7e40')}>{importing ? '…' : t('exercises.import_defaults')}</button>
          <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('exercises.add')}</button>
        </div>
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(e) => e.id} loading={loading}
                 loadingText={t('exercises.loading')} emptyText={t('exercises.empty')} />

      <CrudModal
        open={modalOpen}
        title={editing ? t('exercises.modal_edit') : t('exercises.modal_add')}
        error={error} saving={saving}
        cancelLabel={t('exercises.cancel')}
        saveLabel={saving ? t('exercises.saving') : editing ? t('exercises.save_changes') : t('exercises.modal_add')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }}
        onSave={save}
      >
        <FormLabel>{t('exercises.label_name')} *</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        <FormLabel>{t('exercises.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormLabel>{t('exercises.label_video_url')}</FormLabel>
        <FormInput type="url" value={form.video_url} onChange={(e) => setForm({ ...form, video_url: e.target.value })} />
        <FormLabel>{t('exercises.label_image_url')}</FormLabel>
        <FormInput type="url" value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} />
        <FormLabel>{t('exercises.label_default_reps')}</FormLabel>
        <FormInput value={form.default_reps} onChange={(e) => setForm({ ...form, default_reps: e.target.value })} placeholder="e.g. 4x8" />
        <FormLabel>{t('exercises.label_default_rest')}</FormLabel>
        <FormInput type="number" min="0" value={form.default_rest_seconds} onChange={(e) => setForm({ ...form, default_rest_seconds: e.target.value })} />

        <FormLabel>{t('exercises.label_muscles')}</FormLabel>
        {muscles.length === 0 ? (
          <p style={{ fontSize: 13, color: '#666', margin: 0 }}>{t('exercises.no_muscles')}</p>
        ) : (
          <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {muscles.map((m) => {
              const role = selectedMuscles.get(m.id);
              return (
                <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                  <input type="checkbox" checked={!!role}
                         onChange={(e) => {
                           const next = new Map(selectedMuscles);
                           if (e.target.checked) next.set(m.id, 'principal');
                           else next.delete(m.id);
                           setSelectedMuscles(next);
                         }} />
                  <span style={{ flex: 1 }}>{m.name}</span>
                  {role && (
                    <select value={role} onChange={(e) => {
                      const next = new Map(selectedMuscles);
                      next.set(m.id, e.target.value as any);
                      setSelectedMuscles(next);
                    }} style={{ fontSize: 12, padding: '2px 4px' }}>
                      <option value="principal">{t('exercises.role_principal')}</option>
                      <option value="secondary">{t('exercises.role_secondary')}</option>
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CrudModal>

      <ConfirmDialog open={deleting !== null} message={t('exercises.confirm_delete')}
                     confirmLabel={t('exercises.delete')} cancelLabel={t('exercises.cancel')}
                     onConfirm={del} onCancel={() => setDeleting(null)} />
    </div>
  );
}
