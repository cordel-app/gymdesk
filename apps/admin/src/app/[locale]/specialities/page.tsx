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
import { btnStyle, btnSmall } from '@/components/ui';

interface Speciality { id: number; name: string; description: string | null }

const emptyForm = { name: '', description: '' };

export default function SpecialitiesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Speciality[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Speciality | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Speciality | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  useEffect(() => { if (!gymLoading && !isAdmin) router.replace(`/${locale}`); }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try { setRows(await apiFetch<Speciality[]>('/specialities')); }
    catch (err: any) { setRows([]); toast(err.message ?? t('specialities.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  async function save() {
    if (!form.name.trim()) { setError(t('specialities.error_required')); return; }
    setSaving(true); setError(null);
    const body = { name: form.name.trim(), description: form.description.trim() || null };
    try {
      if (editing) await apiFetch(`/specialities/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/specialities', { method: 'POST', body: JSON.stringify(body) });
      setModalOpen(false); setEditing(null); setForm(emptyForm); load();
    } catch (err: any) { setError(err.message ?? t('specialities.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`/specialities/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('specialities.error_generic')); }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<Speciality>[] = [
    { header: t('specialities.col_name'), render: (r) => r.name },
    { header: t('specialities.col_description'), render: (r) => r.description ?? '—' },
    {
      header: t('specialities.col_actions'), width: 180,
      render: (r) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => { setEditing(r); setForm({ name: r.name, description: r.description ?? '' }); setError(null); setModalOpen(true); }} style={btnSmall('#444')}>{t('specialities.edit')}</button>
          <button onClick={() => setDeleting(r)} style={btnSmall('#c0392b')}>{t('specialities.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('specialities.title')}</h1>
        <button onClick={() => { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }} style={btnStyle('#6c63ff')}>{t('specialities.add')}</button>
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading}
                 loadingText={t('specialities.loading')} emptyText={t('specialities.empty')} />

      <CrudModal
        open={modalOpen}
        title={editing ? t('specialities.modal_edit') : t('specialities.modal_add')}
        error={error} saving={saving}
        cancelLabel={t('specialities.cancel')}
        saveLabel={saving ? t('specialities.saving') : editing ? t('specialities.save_changes') : t('specialities.modal_add')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }}
        onSave={save}
      >
        <FormLabel>{t('specialities.label_name')}</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        <FormLabel>{t('specialities.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </CrudModal>

      <ConfirmDialog open={deleting !== null} message={t('specialities.confirm_delete')}
                     confirmLabel={t('specialities.delete')} cancelLabel={t('specialities.cancel')}
                     onConfirm={del} onCancel={() => setDeleting(null)} />
    </div>
  );
}
