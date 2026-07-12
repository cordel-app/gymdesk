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

interface Pkg {
  id: number; name: string; number_of_sessions: number;
  price: string; validity_days: number; status: 'active' | 'inactive';
}
const STATUSES = ['active', 'inactive'] as const;
const emptyForm = { name: '', number_of_sessions: '', price: '', validity_days: '', status: 'active' };

export default function ClassPackagesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Pkg[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Pkg | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Pkg | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  useEffect(() => { if (!gymLoading && !isAdmin) router.replace(`/${locale}`); }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try { setRows(await apiFetch<Pkg[]>(`/class-packages${statusFilter ? `?status=${statusFilter}` : ''}`)); }
    catch (err: any) { setRows([]); toast(err.message ?? t('class_packages.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

  async function save() {
    if (!form.name.trim() || !form.number_of_sessions || !form.price || !form.validity_days) {
      setError(t('class_packages.error_required')); return;
    }
    const sessions = parseInt(form.number_of_sessions, 10);
    const validity = parseInt(form.validity_days, 10);
    const price = parseFloat(form.price);
    if (sessions <= 0 || validity <= 0 || price < 0) { setError(t('class_packages.error_positive')); return; }
    setSaving(true); setError(null);
    const body = { name: form.name.trim(), number_of_sessions: sessions, price, validity_days: validity, status: form.status };
    try {
      if (editing) await apiFetch(`/class-packages/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/class-packages', { method: 'POST', body: JSON.stringify(body) });
      setModalOpen(false); setEditing(null); setForm(emptyForm); load();
    } catch (err: any) { setError(err.message ?? t('class_packages.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`/class-packages/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('class_packages.error_generic')); }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<Pkg>[] = [
    { header: t('class_packages.col_name'), render: (p) => p.name },
    { header: t('class_packages.col_sessions'), width: 100, render: (p) => p.number_of_sessions },
    { header: t('class_packages.col_price'), width: 100, render: (p) => parseFloat(p.price).toFixed(2) },
    { header: t('class_packages.col_validity'), width: 120, render: (p) => t('class_packages.days', { n: p.validity_days }) },
    { header: t('class_packages.col_status'), width: 110, render: (p) => <StatusBadge status={p.status} label={t(`status.${p.status}`)} /> },
    {
      header: t('class_packages.col_actions'), width: 180,
      render: (p) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => { setEditing(p); setForm({ name: p.name, number_of_sessions: String(p.number_of_sessions), price: p.price, validity_days: String(p.validity_days), status: p.status }); setError(null); setModalOpen(true); }} style={btnSmall('#444')}>{t('class_packages.edit')}</button>
          <button onClick={() => setDeleting(p)} style={btnSmall('#c0392b')}>{t('class_packages.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('class_packages.title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter value={statusFilter} onChange={setStatusFilter}
                        options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
                        allLabel={t('status.all')} />
          <button onClick={() => { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }} style={btnStyle('#6c63ff')}>{t('class_packages.add')}</button>
        </div>
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading}
                 loadingText={t('class_packages.loading')} emptyText={t('class_packages.empty')} />

      <CrudModal
        open={modalOpen}
        title={editing ? t('class_packages.modal_edit') : t('class_packages.modal_add')}
        error={error} saving={saving}
        cancelLabel={t('class_packages.cancel')}
        saveLabel={saving ? t('class_packages.saving') : editing ? t('class_packages.save_changes') : t('class_packages.modal_add')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }}
        onSave={save}
      >
        <FormLabel>{t('class_packages.label_name')} *</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        <FormLabel>{t('class_packages.label_sessions')} *</FormLabel>
        <FormInput type="number" min="1" step="1" value={form.number_of_sessions} onChange={(e) => setForm({ ...form, number_of_sessions: e.target.value })} />
        <FormLabel>{t('class_packages.label_price')} *</FormLabel>
        <FormInput type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        <FormLabel>{t('class_packages.label_validity')} *</FormLabel>
        <FormInput type="number" min="1" step="1" value={form.validity_days} onChange={(e) => setForm({ ...form, validity_days: e.target.value })} />
        <FormLabel>{t('class_packages.label_status')}</FormLabel>
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog open={deleting !== null} message={t('class_packages.confirm_delete')}
                     confirmLabel={t('class_packages.delete')} cancelLabel={t('class_packages.cancel')}
                     onConfirm={del} onCancel={() => setDeleting(null)} />
    </div>
  );
}
