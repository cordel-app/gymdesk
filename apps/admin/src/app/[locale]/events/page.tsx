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

interface GymEvent {
  id: number;
  name: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  status: 'scheduled' | 'cancelled' | 'completed';
  booked_count: number;
  waitlist_count: number;
}

interface EventBooking {
  id: number;
  member_id: number;
  member_name: string;
  status: 'booked' | 'waitlisted' | 'cancelled';
  waitlist_position: number | null;
  booked_at: string | null;
  waitlisted_at: string | null;
}

interface Member { id: number; name: string }

const STATUSES = ['scheduled', 'cancelled', 'completed'] as const;
const emptyForm = { name: '', description: '', starts_at: '', ends_at: '', capacity: '', status: 'scheduled' };

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function OccupancyBadge({ booked, capacity }: { booked: number; capacity: number | null }) {
  const isFull = capacity !== null && booked >= capacity;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span>{capacity !== null ? `${booked} / ${capacity}` : `${booked} / ∞`}</span>
      {isFull && (
        <span style={{ background: '#c0392b', color: '#fff', borderRadius: 4, padding: '1px 6px', fontSize: 11, fontWeight: 700 }}>
          FULL
        </span>
      )}
    </span>
  );
}

function EventRoster({
  event,
  canWrite,
  onChanged,
}: {
  event: GymEvent;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [bookings, setBookings] = useState<EventBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<Member[]>([]);
  const [addMemberId, setAddMemberId] = useState('');
  const [addingMember, setAddingMember] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<EventBooking | null>(null);

  const isFull = event.capacity !== null && event.booked_count >= event.capacity;

  async function loadBookings() {
    setLoading(true);
    try {
      const data = await apiFetch<EventBooking[]>(`/event-bookings?event_id=${event.id}`);
      setBookings(data);
    } catch (err: any) {
      toast(err.message ?? t('event_bookings.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  async function loadMembers() {
    try {
      const data = await apiFetch<Member[]>('/members');
      setMembers(data);
    } catch { /* non-critical */ }
  }

  useEffect(() => { loadBookings(); loadMembers(); }, [event.id]);

  async function handleAddMember() {
    if (!addMemberId) return;
    setAddingMember(true);
    try {
      await apiFetch('/event-bookings', {
        method: 'POST',
        body: JSON.stringify({ event_id: event.id, member_id: parseInt(addMemberId, 10) }),
      });
      setAddMemberId('');
      loadBookings();
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('event_bookings.error_generic'));
    } finally {
      setAddingMember(false);
    }
  }

  async function handleRemove(booking: EventBooking) {
    try {
      await apiFetch(`/event-bookings/${booking.id}`, { method: 'DELETE' });
      setConfirmRemove(null);
      loadBookings();
      onChanged();
    } catch (err: any) {
      setConfirmRemove(null);
      toast(err.message ?? t('event_bookings.error_generic'));
    }
  }

  async function handlePromote(booking: EventBooking) {
    try {
      await apiFetch(`/event-bookings/${booking.id}/promote`, { method: 'POST' });
      loadBookings();
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('event_bookings.error_generic'));
    }
  }

  const confirmed = bookings.filter((b) => b.status === 'booked');
  const waitlisted = bookings.filter((b) => b.status === 'waitlisted');

  const cellStyle: React.CSSProperties = { padding: '6px 10px', borderBottom: '1px solid var(--gd-card-border, #eee)', fontSize: 14 };
  const thStyle: React.CSSProperties = { ...cellStyle, fontWeight: 600, background: 'var(--gd-card-background, #f9f9f9)', color: 'var(--gd-sidebar-text, #555)' };

  return (
    <div style={{ padding: '16px 24px 20px', display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* Confirmed Bookings */}
      <div>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>
          {t('event_bookings.label_confirmed')} ({confirmed.length})
        </h3>
        {loading ? (
          <p style={{ fontSize: 13, color: '#888', margin: 0 }}>{t('event_bookings.loading')}</p>
        ) : confirmed.length === 0 ? (
          <p style={{ fontSize: 13, color: '#888', margin: 0 }}>{t('event_bookings.empty_confirmed')}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>{t('event_bookings.col_member')}</th>
                <th style={thStyle}>{t('event_bookings.col_booking_date')}</th>
                <th style={{ ...thStyle, width: 90 }}>{t('event_bookings.col_status')}</th>
                {canWrite && <th style={{ ...thStyle, width: 80 }}>{t('event_bookings.col_actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {confirmed.map((b) => (
                <tr key={b.id}>
                  <td style={cellStyle}>{b.member_name}</td>
                  <td style={cellStyle}>{b.booked_at ? new Date(b.booked_at).toLocaleString() : '—'}</td>
                  <td style={cellStyle}><StatusBadge status={b.status} label={t(`status.${b.status}`)} /></td>
                  {canWrite && (
                    <td style={cellStyle}>
                      <button onClick={() => setConfirmRemove(b)} style={btnSmall('#c0392b')}>{t('event_bookings.remove')}</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Waiting List */}
      <div>
        <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>
          {t('event_bookings.label_waitlist')} ({waitlisted.length})
        </h3>
        {!loading && waitlisted.length === 0 && (
          <p style={{ fontSize: 13, color: '#888', margin: 0 }}>{t('event_bookings.empty_waitlist')}</p>
        )}
        {!loading && waitlisted.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 60 }}>{t('event_bookings.col_position')}</th>
                <th style={thStyle}>{t('event_bookings.col_member')}</th>
                <th style={thStyle}>{t('event_bookings.col_waiting_since')}</th>
                {canWrite && <th style={{ ...thStyle, width: 150 }}>{t('event_bookings.col_actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {waitlisted.map((b) => (
                <tr key={b.id}>
                  <td style={{ ...cellStyle, textAlign: 'center' }}>{b.waitlist_position}</td>
                  <td style={cellStyle}>{b.member_name}</td>
                  <td style={cellStyle}>{b.waitlisted_at ? new Date(b.waitlisted_at).toLocaleString() : '—'}</td>
                  {canWrite && (
                    <td style={{ ...cellStyle, display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => handlePromote(b)}
                        disabled={isFull}
                        style={btnSmall(isFull ? '#aaa' : '#27ae60')}
                        title={isFull ? t('event_bookings.promote_disabled') : undefined}
                      >
                        {t('event_bookings.promote')}
                      </button>
                      <button onClick={() => setConfirmRemove(b)} style={btnSmall('#c0392b')}>{t('event_bookings.remove')}</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Member */}
      {canWrite && event.status === 'scheduled' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={addMemberId}
            onChange={(e) => setAddMemberId(e.target.value)}
            style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }}
          >
            <option value="">{t('event_bookings.select_member')}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <button
            onClick={handleAddMember}
            disabled={!addMemberId || addingMember}
            style={btnStyle('#6c63ff')}
          >
            {t('event_bookings.add_member')}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        message={t('event_bookings.confirm_remove')}
        confirmLabel={t('event_bookings.remove')}
        cancelLabel={t('events.cancel')}
        onConfirm={() => confirmRemove && handleRemove(confirmRemove)}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  );
}

export default function EventsPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [events, setEvents] = useState<GymEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<Set<number>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<GymEvent | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<GymEvent | null>(null);

  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'ORGANIZATION'));

  useEffect(() => {
    if (!gymLoading && !canWrite) router.replace(`/${locale}`);
  }, [gymLoading, canWrite]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setEvents(await apiFetch<GymEvent[]>(`/events${statusFilter ? `?status=${statusFilter}` : ''}`));
    } catch (err: any) {
      setEvents([]);
      toast(err.message ?? t('events.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

  function toggleExpand(ev: GymEvent) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      next.has(ev.id) ? next.delete(ev.id) : next.add(ev.id);
      return next;
    });
  }

  function openAdd() { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }
  function openEdit(ev: GymEvent) {
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

  if (gymLoading || !canWrite) return null;

  const columns: Column<GymEvent>[] = [
    { header: t('events.col_name'), render: (ev) => ev.name },
    { header: t('events.col_starts_at'), render: (ev) => new Date(ev.starts_at).toLocaleString() },
    { header: t('events.col_ends_at'), render: (ev) => new Date(ev.ends_at).toLocaleString() },
    {
      header: t('events.col_capacity'), width: 130,
      render: (ev) => <OccupancyBadge booked={ev.booked_count} capacity={ev.capacity} />,
    },
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
        expandedRowKeys={expandedKeys as Set<React.Key>}
        onToggleExpand={toggleExpand}
        renderExpanded={(ev) => (
          <EventRoster event={ev} canWrite={canWrite} onChanged={load} />
        )}
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
