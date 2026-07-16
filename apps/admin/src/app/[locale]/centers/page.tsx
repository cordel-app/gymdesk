'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useCenter } from '@/context/CenterContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall } from '@/components/ui';

interface Center {
  id: number;
  name: string;
  code: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  status: 'active' | 'inactive';
}

const STATUSES = ['active', 'inactive'] as const;
const emptyForm = { name: '', code: '', address: '', phone: '', email: '', status: 'active' };

export default function CentersPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { refreshCenters } = useCenter();
  const { toast } = useToast();

  const [centers, setCenters] = useState<Center[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Center | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Center | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  useEffect(() => {
    if (!gymLoading && !isAdmin) router.replace(`/${locale}`);
  }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setCenters(await apiFetch<Center[]>(`/centers${statusFilter ? `?status=${statusFilter}` : ''}`));
    } catch (err: any) {
      setCenters([]);
      toast(err.message ?? t('centers.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

  function openAdd() { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }
  function openEdit(c: Center) {
    setEditing(c);
    setForm({ name: c.name, code: c.code ?? '', address: c.address ?? '', phone: c.phone ?? '', email: c.email ?? '', status: c.status });
    setError(null); setModalOpen(true);
  }
  function closeModal() { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }

  async function handleSave() {
    if (!form.name.trim()) { setError(t('centers.error_required')); return; }
    setSaving(true); setError(null);
    const body = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      address: form.address.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      status: form.status,
    };
    try {
      if (editing) await apiFetch(`/centers/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/centers', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); load(); refreshCenters();
    } catch (err: any) {
      setError(err.message ?? t('centers.error_generic'));
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/centers/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null); load(); refreshCenters();
    } catch (err: any) { setDeleting(null); toast(err.message ?? t('centers.error_generic')); }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<Center>[] = [
    { header: t('centers.col_name'), render: (c) => c.name },
    { header: t('centers.col_code'), width: 100, render: (c) => c.code ?? '—' },
    { header: t('centers.col_address'), render: (c) => c.address ?? '—' },
    { header: t('centers.col_status'), width: 110, render: (c) => <StatusBadge status={c.status} label={t(`status.${c.status}`)} /> },
    {
      header: t('centers.col_actions'), width: 180,
      render: (c) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => openEdit(c)} style={btnSmall('#444')}>{t('centers.edit')}</button>
          <button onClick={() => setDeleting(c)} style={btnSmall('#c0392b')}>{t('centers.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('centers.title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('centers.add')}</button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={centers}
        rowKey={(c) => c.id}
        loading={loading}
        loadingText={t('centers.loading')}
        emptyText={t('centers.empty')}
      />

      <CrudModal
        open={modalOpen}
        title={editing ? t('centers.modal_edit') : t('centers.modal_add')}
        error={error}
        saving={saving}
        cancelLabel={t('centers.cancel')}
        saveLabel={saving ? t('centers.saving') : editing ? t('centers.save_changes') : t('centers.modal_add')}
        onCancel={closeModal}
        onSave={handleSave}
      >
        <FormLabel>{t('centers.label_name')}</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('centers.placeholder_name')} autoFocus />
        <FormLabel>{t('centers.label_code')}</FormLabel>
        <FormInput value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        <FormLabel>{t('centers.label_address')}</FormLabel>
        <FormInput value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        <FormLabel>{t('centers.label_phone')}</FormLabel>
        <FormInput value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <FormLabel>{t('centers.label_email')}</FormLabel>
        <FormInput type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <FormLabel>{t('centers.label_status')}</FormLabel>
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={t('centers.confirm_delete')}
        confirmLabel={t('centers.delete')}
        cancelLabel={t('centers.cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
