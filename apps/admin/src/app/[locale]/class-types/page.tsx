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

interface ClassType {
  id: number;
  name: string;
  description: string | null;
  duration_minutes: number;
  intensity_level: number | null;
  max_capacity: number;
  speciality_id: number | null;
  speciality_name: string | null;
  status: 'active' | 'inactive';
}
interface Speciality { id: number; name: string }

const STATUSES = ['active', 'inactive'] as const;
const emptyForm = { name: '', description: '', duration_minutes: '', intensity_level: '', max_capacity: '', speciality_id: '', status: 'active' };

export default function ClassTypesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<ClassType[]>([]);
  const [specs, setSpecs] = useState<Speciality[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ClassType | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ClassType | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  useEffect(() => { if (!gymLoading && !isAdmin) router.replace(`/${locale}`); }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [ct, ss] = await Promise.all([
        apiFetch<ClassType[]>(`/class-types${statusFilter ? `?status=${statusFilter}` : ''}`),
        apiFetch<Speciality[]>('/specialities'),
      ]);
      setRows(ct); setSpecs(ss);
    } catch (err: any) { toast(err.message ?? t('class_types.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

  async function save() {
    if (!form.name.trim() || !form.duration_minutes.trim() || !form.max_capacity.trim()) {
      setError(t('class_types.error_required')); return;
    }
    setSaving(true); setError(null);
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      duration_minutes: parseInt(form.duration_minutes, 10),
      max_capacity: parseInt(form.max_capacity, 10),
      intensity_level: form.intensity_level ? parseInt(form.intensity_level, 10) : null,
      speciality_id: form.speciality_id ? parseInt(form.speciality_id, 10) : null,
      status: form.status,
    };
    try {
      if (editing) await apiFetch(`/class-types/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/class-types', { method: 'POST', body: JSON.stringify(body) });
      setModalOpen(false); setEditing(null); setForm(emptyForm); load();
    } catch (err: any) { setError(err.message ?? t('class_types.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`/class-types/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('class_types.error_generic')); }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<ClassType>[] = [
    { header: t('class_types.col_name'), render: (r) => r.name },
    { header: t('class_types.col_speciality'), render: (r) => r.speciality_name ?? '—' },
    { header: t('class_types.col_duration'), width: 100, render: (r) => `${r.duration_minutes} min` },
    { header: t('class_types.col_capacity'), width: 100, render: (r) => r.max_capacity },
    { header: t('class_types.col_intensity'), width: 100, render: (r) => r.intensity_level ?? '—' },
    { header: t('class_types.col_status'), width: 110, render: (r) => <StatusBadge status={r.status} label={t(`status.${r.status}`)} /> },
    {
      header: t('class_types.col_actions'), width: 180,
      render: (r) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => { setEditing(r); setForm({ name: r.name, description: r.description ?? '', duration_minutes: String(r.duration_minutes), intensity_level: r.intensity_level ? String(r.intensity_level) : '', max_capacity: String(r.max_capacity), speciality_id: r.speciality_id ? String(r.speciality_id) : '', status: r.status }); setError(null); setModalOpen(true); }} style={btnSmall('#444')}>{t('class_types.edit')}</button>
          <button onClick={() => setDeleting(r)} style={btnSmall('#c0392b')}>{t('class_types.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('class_types.title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter value={statusFilter} onChange={setStatusFilter}
                        options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
                        allLabel={t('status.all')} />
          <button onClick={() => { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }} style={btnStyle('#6c63ff')}>{t('class_types.add')}</button>
        </div>
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading}
                 loadingText={t('class_types.loading')} emptyText={t('class_types.empty')} />

      <CrudModal
        open={modalOpen}
        title={editing ? t('class_types.modal_edit') : t('class_types.modal_add')}
        error={error} saving={saving}
        cancelLabel={t('class_types.cancel')}
        saveLabel={saving ? t('class_types.saving') : editing ? t('class_types.save_changes') : t('class_types.modal_add')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }}
        onSave={save}
      >
        <FormLabel>{t('class_types.label_name')}</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        <FormLabel>{t('class_types.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormLabel>{t('class_types.label_duration')}</FormLabel>
        <FormInput type="number" min="1" step="1" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })} />
        <FormLabel>{t('class_types.label_capacity')}</FormLabel>
        <FormInput type="number" min="1" step="1" value={form.max_capacity} onChange={(e) => setForm({ ...form, max_capacity: e.target.value })} />
        <FormLabel>{t('class_types.label_intensity')}</FormLabel>
        <FormInput type="number" min="1" max="5" step="1" value={form.intensity_level} onChange={(e) => setForm({ ...form, intensity_level: e.target.value })} />
        <FormLabel>{t('class_types.label_speciality')}</FormLabel>
        <select value={form.speciality_id} onChange={(e) => setForm({ ...form, speciality_id: e.target.value })}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}>
          <option value="">—</option>
          {specs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <FormLabel>{t('class_types.label_status')}</FormLabel>
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog open={deleting !== null} message={t('class_types.confirm_delete')}
                     confirmLabel={t('class_types.delete')} cancelLabel={t('class_types.cancel')}
                     onConfirm={del} onCancel={() => setDeleting(null)} />
    </div>
  );
}
