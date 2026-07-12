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
import { PromotionDetailModal } from './PromotionDetailModal';

interface Promo {
  id: number; name: string; description: string | null;
  starts_at: string; ends_at: string; stackable: number;
  status: 'active' | 'inactive';
}
const STATUSES = ['active', 'inactive'] as const;
const emptyForm = { name: '', description: '', starts_at: '', ends_at: '', stackable: false, status: 'active' };

const iso = (v: string) => v ? v.slice(0, 10) : '';

export default function PromotionsPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Promo | null>(null);
  const [form, setForm] = useState<any>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Promo | null>(null);
  const [detailFor, setDetailFor] = useState<Promo | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  useEffect(() => { if (!gymLoading && !isAdmin) router.replace(`/${locale}`); }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try { setRows(await apiFetch<Promo[]>(`/promotions${statusFilter ? `?status=${statusFilter}` : ''}`)); }
    catch (err: any) { setRows([]); toast(err.message ?? t('promotions.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

  async function save() {
    if (!form.name.trim() || !form.starts_at || !form.ends_at) { setError(t('promotions.error_required')); return; }
    if (new Date(form.starts_at) > new Date(form.ends_at)) { setError(t('promotions.error_dates')); return; }
    setSaving(true); setError(null);
    const body = { name: form.name.trim(), description: form.description.trim() || null,
      starts_at: form.starts_at, ends_at: form.ends_at, stackable: form.stackable, status: form.status };
    try {
      if (editing) await apiFetch(`/promotions/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/promotions', { method: 'POST', body: JSON.stringify(body) });
      setModalOpen(false); setEditing(null); setForm(emptyForm); load();
    } catch (err: any) { setError(err.message ?? t('promotions.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`/promotions/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('promotions.error_generic')); }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<Promo>[] = [
    { header: t('promotions.col_name'), render: (p) => p.name },
    { header: t('promotions.col_dates'), render: (p) => `${iso(p.starts_at)} → ${iso(p.ends_at)}` },
    { header: t('promotions.col_stackable'), width: 100, render: (p) => p.stackable ? t('promotions.yes') : t('promotions.no') },
    { header: t('promotions.col_status'), width: 110, render: (p) => <StatusBadge status={p.status} label={t(`status.${p.status}`)} /> },
    {
      header: t('promotions.col_actions'), width: 260,
      render: (p) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setDetailFor(p)} style={btnSmall('#6c63ff')}>{t('promotions.detail')}</button>
          <button onClick={() => { setEditing(p); setForm({ name: p.name, description: p.description ?? '', starts_at: iso(p.starts_at), ends_at: iso(p.ends_at), stackable: !!p.stackable, status: p.status }); setError(null); setModalOpen(true); }} style={btnSmall('#444')}>{t('promotions.edit')}</button>
          <button onClick={() => setDeleting(p)} style={btnSmall('#c0392b')}>{t('promotions.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('promotions.title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter value={statusFilter} onChange={setStatusFilter}
                        options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
                        allLabel={t('status.all')} />
          <button onClick={() => { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }} style={btnStyle('#6c63ff')}>{t('promotions.add')}</button>
        </div>
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading}
                 loadingText={t('promotions.loading')} emptyText={t('promotions.empty')} />

      <CrudModal
        open={modalOpen}
        title={editing ? t('promotions.modal_edit') : t('promotions.modal_add')}
        error={error} saving={saving}
        cancelLabel={t('promotions.cancel')}
        saveLabel={saving ? t('promotions.saving') : editing ? t('promotions.save_changes') : t('promotions.modal_add')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }}
        onSave={save}
      >
        <FormLabel>{t('promotions.label_name')} *</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <FormLabel>{t('promotions.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormLabel>{t('promotions.label_starts')} *</FormLabel>
        <FormInput type="date" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
        <FormLabel>{t('promotions.label_ends')} *</FormLabel>
        <FormInput type="date" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, fontSize: 14 }}>
          <input type="checkbox" checked={!!form.stackable} onChange={(e) => setForm({ ...form, stackable: e.target.checked })} />
          {t('promotions.label_stackable')}
        </label>
        <FormLabel>{t('promotions.label_status')}</FormLabel>
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog open={deleting !== null} message={t('promotions.confirm_delete')}
                     confirmLabel={t('promotions.delete')} cancelLabel={t('promotions.cancel')}
                     onConfirm={del} onCancel={() => setDeleting(null)} />

      {detailFor && (
        <PromotionDetailModal promotion={detailFor} onClose={() => setDetailFor(null)} />
      )}
    </div>
  );
}
