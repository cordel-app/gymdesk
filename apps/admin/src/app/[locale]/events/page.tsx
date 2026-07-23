'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall } from '@/components/ui';

interface Event {
  id: number;
  name: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  status: 'scheduled' | 'cancelled' | 'completed';
}

const STATUSES = ['scheduled', 'cancelled', 'completed'] as const;
const emptyForm = { name: '', description: '', starts_at: '', ends_at: '', capacity: '', status: 'scheduled' };

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function EventsPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Event | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Event | null>(null);

  const isAdmin = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'ORGANIZATION'));

  useEffect(() => {
    if (!gymLoading && !isAdmin) router.replace(`/${locale}`);
  }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setEvents(await apiFetch<Event[]>(`/events${statusFilter ? `?status=${statusFilter}` : ''}`));
    } catch (err: any) {
      setEvents([]);
      toast(err.message ?? t('events.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

  function openAdd() { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }
  function openEdit(ev: Event) {
    setEditing(ev);
    setForm({
      name: ev.name, description: ev.description ?? '',
      starts_at: toLocalInput(ev.starts_at), ends_at: toLocalInput(ev.ends_at),
      capacity: ev.capacity != null ? String(ev.capacity) : '', status: ev.status,
    });
    setError(null); setModalOpen(true);
  }
  function closeModal() { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }

  async function handleSave() {
    if (!form.name.trim() || !form.starts_at || !form.ends_at) { setError(t('events.error_required')); return; }
    if (new Date(form.starts_at) >= new Date(form.ends_at)) { setError(t('events.error_time_range')); return; }
    setSaving(true); setError(null);
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      starts_at: new Date(form.starts_at).toISOString(),
      ends_at: new Date(form.ends_at).toISOString(),
      capacity: form.capacity ? parseInt(form.capacity, 10) : null,
      status: form.status,
    };
    try {
      if (editing) await apiFetch(`/events/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/events', { method: 'POST', body: JSON.stringify(body) });
      closeModal(); load();
    } catch (err: any) {
      setError(err.message ?? t('events.error_generic'));
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/events/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null); load();
    } catch (err: any) { setDeleting(null); toast(err.message ?? t('events.error_generic')); }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<Event>[] = [
    { header: t('events.col_name'), render: (ev) => ev.name },
    { header: t('events.col_starts_at'), render: (ev) => new Date(ev.starts_at).toLocaleString() },
    { header: t('events.col_ends_at'), render: (ev) => new Date(ev.ends_at).toLocaleString() },
    { header: t('events.col_capacity'), width: 100, render: (ev) => ev.capacity ?? '—' },
    { header: t('events.col_status'), width: 110, render: (ev) => <StatusBadge status={ev.status} label={t(`status.${ev.status}`)} /> },
    {
      header: t('events.col_actions'), width: 180,
      render: (ev) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => openEdit(ev)} style={btnSmall('#444')}>{t('events.edit')}</button>
          <button onClick={() => setDeleting(ev)} style={btnSmall('#c0392b')}>{t('events.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('events.title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('events.add')}</button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={events}
        rowKey={(ev) => ev.id}
        loading={loading}
        loadingText={t('events.loading')}
        emptyText={t('events.empty')}
      />

      <CrudModal
        open={modalOpen}
        title={editing ? t('events.modal_edit') : t('events.modal_add')}
        error={error}
        saving={saving}
        cancelLabel={t('events.cancel')}
        saveLabel={saving ? t('events.saving') : editing ? t('events.save_changes') : t('events.modal_add')}
        onCancel={closeModal}
        onSave={handleSave}
      >
        <FormLabel>{t('events.label_name')}</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('events.placeholder_name')} autoFocus />
        <FormLabel>{t('events.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormLabel>{t('events.label_starts_at')}</FormLabel>
        <FormInput type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
        <FormLabel>{t('events.label_ends_at')}</FormLabel>
        <FormInput type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
        <FormLabel>{t('events.label_capacity')}</FormLabel>
        <FormInput type="number" min="1" step="1" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
        <FormLabel>{t('events.label_status')}</FormLabel>
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={t('events.confirm_delete')}
        confirmLabel={t('events.delete')}
        cancelLabel={t('events.cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
