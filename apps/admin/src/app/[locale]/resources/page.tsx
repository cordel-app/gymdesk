'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall } from '@/components/ui';

interface Resource {
  id: number;
  name: string;
  description: string | null;
  quantity: number;
  status: 'active' | 'inactive';
}

const STATUSES = ['active', 'inactive'] as const;
const emptyForm = { name: '', description: '', quantity: '1', status: 'active' };

export default function ResourcesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Resource | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Resource | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  useEffect(() => {
    if (!gymLoading && !isAdmin) router.replace(`/${locale}`);
  }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setResources(await apiFetch<Resource[]>(`/resources${statusFilter ? `?status=${statusFilter}` : ''}`));
    } catch (err: any) {
      setResources([]);
      toast(err.message ?? t('resources.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

  function openAdd() { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }
  function openEdit(r: Resource) {
    setEditing(r);
    setForm({ name: r.name, description: r.description ?? '', quantity: String(r.quantity), status: r.status });
    setError(null); setModalOpen(true);
  }
  function closeModal() { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }

  async function handleSave() {
    if (!form.name.trim() || !form.quantity.trim()) { setError(t('resources.error_required')); return; }
    const qty = parseInt(form.quantity, 10);
    if (isNaN(qty) || qty <= 0) { setError(t('resources.error_quantity')); return; }
    setSaving(true); setError(null);
    const body = { name: form.name.trim(), description: form.description.trim() || null, quantity: qty, status: form.status };
    try {
      if (editing) await apiFetch(`/resources/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/resources', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); load();
    } catch (err: any) {
      setError(err.message ?? t('resources.error_generic'));
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/resources/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null); load();
    } catch (err: any) { setDeleting(null); toast(err.message ?? t('resources.error_generic')); }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<Resource>[] = [
    { header: t('resources.col_name'), render: (r) => r.name },
    { header: t('resources.col_description'), render: (r) => r.description ?? '—' },
    { header: t('resources.col_quantity'), width: 100, render: (r) => r.quantity },
    { header: t('resources.col_status'), width: 110, render: (r) => <StatusBadge status={r.status} label={t(`status.${r.status}`)} /> },
    {
      header: t('resources.col_actions'), width: 180,
      render: (r) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => openEdit(r)} style={btnSmall('#444')}>{t('resources.edit')}</button>
          <button onClick={() => setDeleting(r)} style={btnSmall('#c0392b')}>{t('resources.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('resources.title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('resources.add')}</button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={resources}
        rowKey={(r) => r.id}
        loading={loading}
        loadingText={t('resources.loading')}
        emptyText={t('resources.empty')}
      />

      <CrudModal
        open={modalOpen}
        title={editing ? t('resources.modal_edit') : t('resources.modal_add')}
        error={error}
        saving={saving}
        cancelLabel={t('resources.cancel')}
        saveLabel={saving ? t('resources.saving') : editing ? t('resources.save_changes') : t('resources.modal_add')}
        onCancel={closeModal}
        onSave={handleSave}
      >
        <FormLabel>{t('resources.label_name')}</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('resources.placeholder_name')} autoFocus />
        <FormLabel>{t('resources.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormLabel>{t('resources.label_quantity')}</FormLabel>
        <FormInput type="number" min="1" step="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
        <FormLabel>{t('resources.label_status')}</FormLabel>
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={t('resources.confirm_delete')}
        confirmLabel={t('resources.delete')}
        cancelLabel={t('resources.cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
