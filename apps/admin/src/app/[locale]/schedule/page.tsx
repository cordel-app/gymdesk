'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useToast } from '@/components/Toast';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { btnStyle, btnSmall } from '@/components/ui';
import { SessionRosterPanel } from './SessionRosterPanel';

interface Session {
  id: number;
  class_type_id: number;
  class_type_name: string;
  class_type_duration: number;
  class_type_capacity: number;
  effective_capacity: number;
  trainer_membership_id: number | null;
  space_id: number | null;
  space_name: string | null;
  starts_at: string;
  ends_at: string;
  max_capacity_override: number | null;
  status: 'scheduled' | 'cancelled' | 'completed';
  cancellation_reason: string | null;
}
interface ClassType { id: number; name: string; duration_minutes: number; max_capacity: number; status: string }
interface Trainer { gym_membership_id: number; user_id: string; specialities: { name: string }[] }
interface Space { id: number; name: string; status: string }

const emptyForm = {
  class_type_id: '',
  trainer_membership_id: '',
  space_id: '',
  starts_at: '',
  duration_minutes: '',
  max_capacity_override: '',
};

const localISO = (d: Date) => {
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
};

function addMinutes(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function dayKey(iso: string) { return iso.slice(0, 10); }

export default function SchedulePage() {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [rangeStart, setRangeStart] = useState(today);
  const [rangeEnd, setRangeEnd] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
  });

  const [sessions, setSessions] = useState<Session[]>([]);
  const [classTypes, setClassTypes] = useState<ClassType[]>([]);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Session | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cancelling, setCancelling] = useState<Session | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [rosterFor, setRosterFor] = useState<Session | null>(null);

  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'TRAINING'));

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [ss, ct, tr, rm] = await Promise.all([
        apiFetch<Session[]>(`/class-sessions?from=${rangeStart}&to=${rangeEnd} 23:59:59`),
        apiFetch<ClassType[]>('/class-types?status=active'),
        apiFetch<Trainer[]>('/trainers'),
        apiFetch<Space[]>('/spaces?status=active'),
      ]);
      setSessions(ss); setClassTypes(ct); setTrainers(tr); setSpaces(rm);
    } catch (err: any) { toast(err.message ?? t('schedule.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, rangeStart, rangeEnd]);

  function openAdd() {
    setEditing(null);
    setForm({ ...emptyForm, starts_at: localISO(new Date()) });
    setError(null); setModalOpen(true);
  }

  function openEdit(s: Session) {
    setEditing(s);
    setForm({
      class_type_id: String(s.class_type_id),
      trainer_membership_id: s.trainer_membership_id ? String(s.trainer_membership_id) : '',
      space_id: s.space_id ? String(s.space_id) : '',
      starts_at: s.starts_at.slice(0, 16),
      duration_minutes: String(s.class_type_duration),
      max_capacity_override: s.max_capacity_override != null ? String(s.max_capacity_override) : '',
    });
    setError(null); setModalOpen(true);
  }

  function onClassTypeChange(id: string) {
    const ct = classTypes.find((c) => c.id === parseInt(id, 10));
    setForm((f) => ({
      ...f,
      class_type_id: id,
      duration_minutes: ct ? String(ct.duration_minutes) : f.duration_minutes,
      max_capacity_override: ct ? '' : f.max_capacity_override,
    }));
  }

  async function save() {
    if (!form.class_type_id || !form.starts_at || !form.duration_minutes) {
      setError(t('schedule.error_required')); return;
    }
    const duration = parseInt(form.duration_minutes, 10);
    if (isNaN(duration) || duration <= 0) { setError(t('schedule.error_duration')); return; }
    const startsAt = new Date(form.starts_at).toISOString();
    const endsAt = addMinutes(form.starts_at, duration);
    const body: any = {
      class_type_id: parseInt(form.class_type_id, 10),
      trainer_membership_id: form.trainer_membership_id ? parseInt(form.trainer_membership_id, 10) : null,
      space_id: form.space_id ? parseInt(form.space_id, 10) : null,
      starts_at: startsAt, ends_at: endsAt,
      max_capacity_override: form.max_capacity_override ? parseInt(form.max_capacity_override, 10) : null,
    };
    setSaving(true); setError(null);
    try {
      if (editing) await apiFetch(`/class-sessions/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/class-sessions', { method: 'POST', body: JSON.stringify(body) });
      setModalOpen(false); setEditing(null); setForm(emptyForm); load();
    } catch (err: any) { setError(err.message ?? t('schedule.error_generic')); }
    finally { setSaving(false); }
  }

  async function confirmCancel() {
    if (!cancelling) return;
    const reason = cancelReason.trim();
    if (!reason) return;
    try {
      await apiFetch(`/class-sessions/${cancelling.id}/cancel`, { method: 'POST', body: JSON.stringify({ cancellation_reason: reason }) });
      setCancelling(null); setCancelReason(''); load();
    } catch (err: any) { toast(err.message ?? t('schedule.error_generic')); }
  }

  const grouped = useMemo(() => {
    const groups = new Map<string, Session[]>();
    for (const s of sessions) {
      const k = dayKey(s.starts_at);
      const arr = groups.get(k) ?? [];
      arr.push(s);
      groups.set(k, arr);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [sessions]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>{t('schedule.title')}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: '#555' }}>{t('schedule.from')}</label>
          <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)}
                 style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }} />
          <label style={{ fontSize: 13, color: '#555' }}>{t('schedule.to')}</label>
          <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)}
                 style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14 }} />
          {canWrite && <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('schedule.add')}</button>}
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#666' }}>{t('schedule.loading')}</p>
      ) : grouped.length === 0 ? (
        <p style={{ color: '#666' }}>{t('schedule.empty')}</p>
      ) : (
        grouped.map(([day, list]) => (
          <div key={day} style={{ marginBottom: 24 }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600, color: '#555' }}>{day}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {list.map((s) => (
                <div key={s.id} style={{ background: '#fff', borderRadius: 8, padding: '10px 14px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ minWidth: 100, fontVariantNumeric: 'tabular-nums', fontSize: 14 }}>
                    {s.starts_at.slice(11, 16)} – {s.ends_at.slice(11, 16)}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{s.class_type_name}</div>
                    <div style={{ fontSize: 13, color: '#666' }}>
                      {s.space_name ?? '—'}
                      {s.trainer_membership_id ? ` · ${t('schedule.trainer')}: ${trainers.find(t => t.gym_membership_id === s.trainer_membership_id)?.user_id.slice(0, 10) ?? '—'}` : ''}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, color: '#666', minWidth: 60, textAlign: 'right' }}>
                    {t('schedule.capacity')}: {s.effective_capacity}
                  </div>
                  <StatusBadge status={s.status === 'scheduled' ? 'active' : s.status === 'cancelled' ? 'cancelled' : 'expired'} label={t(`schedule.status.${s.status}`)} />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => setRosterFor(s)} style={btnSmall('#6c63ff')}>{t('schedule.roster')}</button>
                    {canWrite && s.status === 'scheduled' && <button onClick={() => openEdit(s)} style={btnSmall('#444')}>{t('schedule.edit')}</button>}
                    {canWrite && s.status === 'scheduled' && <button onClick={() => { setCancelling(s); setCancelReason(''); }} style={btnSmall('#c0392b')}>{t('schedule.cancel')}</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <CrudModal
        open={modalOpen}
        title={editing ? t('schedule.modal_edit') : t('schedule.modal_add')}
        error={error} saving={saving}
        cancelLabel={t('schedule.cancel')}
        saveLabel={saving ? t('schedule.saving') : editing ? t('schedule.save_changes') : t('schedule.modal_add')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }}
        onSave={save}
      >
        <FormLabel>{t('schedule.label_class_type')} *</FormLabel>
        <select value={form.class_type_id} onChange={(e) => onClassTypeChange(e.target.value)}
                style={selectStyle} disabled={!!editing}>
          <option value="">—</option>
          {classTypes.map((ct) => <option key={ct.id} value={ct.id}>{ct.name}</option>)}
        </select>
        <FormLabel>{t('schedule.label_starts')} *</FormLabel>
        <FormInput type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
        <FormLabel>{t('schedule.label_duration')} *</FormLabel>
        <FormInput type="number" min="1" step="5" value={form.duration_minutes} onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })} />
        <FormLabel>{t('schedule.label_trainer')}</FormLabel>
        <select value={form.trainer_membership_id} onChange={(e) => setForm({ ...form, trainer_membership_id: e.target.value })}
                style={selectStyle}>
          <option value="">—</option>
          {trainers.map((tr) => <option key={tr.gym_membership_id} value={tr.gym_membership_id}>{tr.user_id.slice(0, 10)}…{tr.specialities.length ? ` (${tr.specialities.map((s) => s.name).join(', ')})` : ''}</option>)}
        </select>
        <FormLabel>{t('schedule.label_space')}</FormLabel>
        <select value={form.space_id} onChange={(e) => setForm({ ...form, space_id: e.target.value })} style={selectStyle}>
          <option value="">—</option>
          {spaces.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
        </select>
        <FormLabel>{t('schedule.label_capacity_override')}</FormLabel>
        <FormInput type="number" min="1" step="1" value={form.max_capacity_override}
                   placeholder={t('schedule.capacity_from_type')}
                   onChange={(e) => setForm({ ...form, max_capacity_override: e.target.value })} />
      </CrudModal>

      <ConfirmDialog
        open={cancelling !== null}
        message={
          <div>
            <p style={{ margin: '0 0 12px', fontSize: 15 }}>{t('schedule.confirm_cancel', { name: cancelling?.class_type_name ?? '' })}</p>
            <input type="text" placeholder={t('schedule.cancel_reason_placeholder')}
                   value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}
                   style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', boxSizing: 'border-box' }} />
          </div> as any
        }
        confirmLabel={t('schedule.cancel_confirm')}
        cancelLabel={t('schedule.cancel')}
        onConfirm={confirmCancel}
        onCancel={() => { setCancelling(null); setCancelReason(''); }}
      />

      {rosterFor && (
        <SessionRosterPanel
          session={rosterFor}
          canAttendance={canWrite}
          onClose={() => setRosterFor(null)}
        />
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6,
  border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff',
};
