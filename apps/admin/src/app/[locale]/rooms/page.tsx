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

interface Room {
  id: number;
  name: string;
  description: string | null;
  capacity: number;
  status: 'active' | 'inactive';
}

const STATUSES = ['active', 'inactive'] as const;
const emptyForm = { name: '', description: '', capacity: '', status: 'active' };

export default function RoomsPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Room | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  useEffect(() => {
    if (!gymLoading && !isAdmin) router.replace(`/${locale}`);
  }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setRooms(await apiFetch<Room[]>(`/rooms${statusFilter ? `?status=${statusFilter}` : ''}`));
    } catch (err: any) {
      setRooms([]);
      toast(err.message ?? t('rooms.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

  function openAdd() { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }
  function openEdit(r: Room) {
    setEditing(r);
    setForm({ name: r.name, description: r.description ?? '', capacity: String(r.capacity), status: r.status });
    setError(null); setModalOpen(true);
  }
  function closeModal() { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }

  async function handleSave() {
    if (!form.name.trim() || !form.capacity.trim()) { setError(t('rooms.error_required')); return; }
    const cap = parseInt(form.capacity, 10);
    if (isNaN(cap) || cap <= 0) { setError(t('rooms.error_capacity')); return; }
    setSaving(true); setError(null);
    const body = { name: form.name.trim(), description: form.description.trim() || null, capacity: cap, status: form.status };
    try {
      if (editing) await apiFetch(`/rooms/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/rooms', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); load();
    } catch (err: any) {
      setError(err.message ?? t('rooms.error_generic'));
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/rooms/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null); load();
    } catch (err: any) { setDeleting(null); toast(err.message ?? t('rooms.error_generic')); }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<Room>[] = [
    { header: t('rooms.col_name'), render: (r) => r.name },
    { header: t('rooms.col_description'), render: (r) => r.description ?? '—' },
    { header: t('rooms.col_capacity'), width: 100, render: (r) => r.capacity },
    { header: t('rooms.col_status'), width: 110, render: (r) => <StatusBadge status={r.status} label={t(`status.${r.status}`)} /> },
    {
      header: t('rooms.col_actions'), width: 180,
      render: (r) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => openEdit(r)} style={btnSmall('#444')}>{t('rooms.edit')}</button>
          <button onClick={() => setDeleting(r)} style={btnSmall('#c0392b')}>{t('rooms.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('rooms.title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('rooms.add')}</button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rooms}
        rowKey={(r) => r.id}
        loading={loading}
        loadingText={t('rooms.loading')}
        emptyText={t('rooms.empty')}
      />

      <CrudModal
        open={modalOpen}
        title={editing ? t('rooms.modal_edit') : t('rooms.modal_add')}
        error={error}
        saving={saving}
        cancelLabel={t('rooms.cancel')}
        saveLabel={saving ? t('rooms.saving') : editing ? t('rooms.save_changes') : t('rooms.modal_add')}
        onCancel={closeModal}
        onSave={handleSave}
      >
        <FormLabel>{t('rooms.label_name')}</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('rooms.placeholder_name')} autoFocus />
        <FormLabel>{t('rooms.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormLabel>{t('rooms.label_capacity')}</FormLabel>
        <FormInput type="number" min="1" step="1" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
        <FormLabel>{t('rooms.label_status')}</FormLabel>
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={t('rooms.confirm_delete')}
        confirmLabel={t('rooms.delete')}
        cancelLabel={t('rooms.cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
