'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { btnStyle, btnSmall } from '@/components/ui';

interface Trainer {
  gym_membership_id: number;
  user_id: string;
  specialities: { id: number; name: string }[];
}
interface Speciality { id: number; name: string }
interface AvailabilityWindow {
  id: number;
  is_recurring: boolean;
  weekday: number | null;
  specific_date: string | null;
  starts_time: string;
  ends_time: string;
  status: 'active' | 'inactive';
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const emptyAvailabilityForm = { is_recurring: true, weekday: '1', specific_date: '', starts_time: '09:00', ends_time: '17:00' };

export default function TrainersPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [specialities, setSpecialities] = useState<Speciality[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Trainer | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [availabilityFor, setAvailabilityFor] = useState<Trainer | null>(null);
  const [availability, setAvailability] = useState<AvailabilityWindow[]>([]);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availabilityForm, setAvailabilityForm] = useState(emptyAvailabilityForm);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [availabilitySaving, setAvailabilitySaving] = useState(false);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  useEffect(() => { if (!gymLoading && !isAdmin) router.replace(`/${locale}`); }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [ts, ss] = await Promise.all([
        apiFetch<Trainer[]>('/trainers'),
        apiFetch<Speciality[]>('/specialities'),
      ]);
      setTrainers(ts); setSpecialities(ss);
    } catch (err: any) { toast(err.message ?? t('trainers.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  function openEdit(tr: Trainer) {
    setEditing(tr);
    setSelected(new Set(tr.specialities.map((s) => s.id)));
    setError(null);
  }

  async function save() {
    if (!editing) return;
    setSaving(true); setError(null);
    try {
      await apiFetch(`/trainers/${editing.gym_membership_id}/specialities`,
        { method: 'PUT', body: JSON.stringify({ speciality_ids: Array.from(selected) }) });
      setEditing(null); load();
    } catch (err: any) { setError(err.message ?? t('trainers.error_generic')); }
    finally { setSaving(false); }
  }

  async function openAvailability(tr: Trainer) {
    setAvailabilityFor(tr);
    setAvailabilityForm(emptyAvailabilityForm);
    setAvailabilityError(null);
    setAvailabilityLoading(true);
    try {
      setAvailability(await apiFetch<AvailabilityWindow[]>(`/trainer-availability?trainer_membership_id=${tr.gym_membership_id}`));
    } catch (err: any) {
      toast(err.message ?? t('trainers.error_generic'));
    } finally {
      setAvailabilityLoading(false);
    }
  }

  async function addAvailability() {
    if (!availabilityFor) return;
    setAvailabilitySaving(true); setAvailabilityError(null);
    const body = availabilityForm.is_recurring
      ? { trainer_membership_id: availabilityFor.gym_membership_id, is_recurring: true, weekday: parseInt(availabilityForm.weekday, 10), starts_time: availabilityForm.starts_time, ends_time: availabilityForm.ends_time }
      : { trainer_membership_id: availabilityFor.gym_membership_id, is_recurring: false, specific_date: availabilityForm.specific_date, starts_time: availabilityForm.starts_time, ends_time: availabilityForm.ends_time };
    try {
      await apiFetch('/trainer-availability', { method: 'POST', body: JSON.stringify(body) });
      setAvailability(await apiFetch<AvailabilityWindow[]>(`/trainer-availability?trainer_membership_id=${availabilityFor.gym_membership_id}`));
      setAvailabilityForm(emptyAvailabilityForm);
    } catch (err: any) {
      setAvailabilityError(err.message ?? t('trainers.error_generic'));
    } finally {
      setAvailabilitySaving(false);
    }
  }

  async function removeAvailability(id: number) {
    if (!availabilityFor) return;
    try {
      await apiFetch(`/trainer-availability/${id}`, { method: 'DELETE' });
      setAvailability(await apiFetch<AvailabilityWindow[]>(`/trainer-availability?trainer_membership_id=${availabilityFor.gym_membership_id}`));
    } catch (err: any) {
      toast(err.message ?? t('trainers.error_generic'));
    }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<Trainer>[] = [
    { header: t('trainers.col_id'), render: (r) => r.user_id.slice(0, 12) + '…' },
    { header: t('trainers.col_specialities'),
      render: (r) => r.specialities.length === 0 ? '—' : r.specialities.map((s) => s.name).join(', ') },
    {
      header: t('trainers.col_actions'), width: 260,
      render: (r) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => openEdit(r)} style={btnSmall('#6c63ff')}>{t('trainers.assign')}</button>
          <button onClick={() => openAvailability(r)} style={btnSmall('#444')}>{t('trainers.availability')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <h1 style={{ margin: '0 0 24px' }}>{t('trainers.title')}</h1>
      <DataTable columns={columns} rows={trainers} rowKey={(r) => r.gym_membership_id} loading={loading}
                 loadingText={t('trainers.loading')} emptyText={t('trainers.empty')} />

      <CrudModal
        open={editing !== null}
        title={t('trainers.modal_assign')}
        error={error} saving={saving}
        cancelLabel={t('trainers.cancel')}
        saveLabel={saving ? t('trainers.saving') : t('trainers.save_changes')}
        onCancel={() => setEditing(null)}
        onSave={save}
      >
        <FormLabel>{t('trainers.label_specialities')}</FormLabel>
        {specialities.length === 0 ? (
          <p style={{ color: '#666', margin: 0, fontSize: 14 }}>{t('trainers.no_specialities')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
            {specialities.map((s) => (
              <label key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                <input type="checkbox" checked={selected.has(s.id)}
                       onChange={(e) => {
                         const next = new Set(selected);
                         if (e.target.checked) next.add(s.id); else next.delete(s.id);
                         setSelected(next);
                       }} />
                {s.name}
              </label>
            ))}
          </div>
        )}
      </CrudModal>

      <CrudModal
        open={availabilityFor !== null}
        title={t('trainers.modal_availability')}
        error={availabilityError}
        saving={availabilitySaving}
        cancelLabel={t('trainers.close')}
        saveLabel={availabilitySaving ? t('trainers.saving') : t('trainers.availability_add')}
        onCancel={() => setAvailabilityFor(null)}
        onSave={addAvailability}
      >
        {availabilityLoading ? (
          <p style={{ color: '#666', fontSize: 14 }}>{t('trainers.loading')}</p>
        ) : availability.length === 0 ? (
          <p style={{ color: '#666', fontSize: 14, margin: '0 0 12px' }}>{t('trainers.availability_empty')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            {availability.map((w) => (
              <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 14, padding: '6px 0', borderBottom: '1px solid #eee' }}>
                <span>
                  {w.is_recurring
                    ? t('trainers.availability_recurring_label', { day: t(`weekday.${w.weekday}`), start: w.starts_time, end: w.ends_time })
                    : t('trainers.availability_oneoff_label', { date: w.specific_date, start: w.starts_time, end: w.ends_time })}
                </span>
                <button onClick={() => removeAvailability(w.id)} style={btnSmall('#c0392b')}>{t('trainers.delete')}</button>
              </div>
            ))}
          </div>
        )}

        <FormLabel>{t('trainers.availability_type')}</FormLabel>
        <select value={availabilityForm.is_recurring ? 'recurring' : 'oneoff'}
                onChange={(e) => setAvailabilityForm({ ...availabilityForm, is_recurring: e.target.value === 'recurring' })}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}>
          <option value="recurring">{t('trainers.availability_recurring')}</option>
          <option value="oneoff">{t('trainers.availability_oneoff')}</option>
        </select>

        {availabilityForm.is_recurring ? (
          <>
            <FormLabel>{t('trainers.availability_weekday')}</FormLabel>
            <select value={availabilityForm.weekday} onChange={(e) => setAvailabilityForm({ ...availabilityForm, weekday: e.target.value })}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}>
              {WEEKDAYS.map((d) => <option key={d} value={d}>{t(`weekday.${d}`)}</option>)}
            </select>
          </>
        ) : (
          <>
            <FormLabel>{t('trainers.availability_date')}</FormLabel>
            <input type="date" value={availabilityForm.specific_date}
                   onChange={(e) => setAvailabilityForm({ ...availabilityForm, specific_date: e.target.value })}
                   style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' }} />
          </>
        )}

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <FormLabel>{t('trainers.availability_starts')}</FormLabel>
            <input type="time" value={availabilityForm.starts_time} onChange={(e) => setAvailabilityForm({ ...availabilityForm, starts_time: e.target.value })}
                   style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' }} />
          </div>
          <div style={{ flex: 1 }}>
            <FormLabel>{t('trainers.availability_ends')}</FormLabel>
            <input type="time" value={availabilityForm.ends_time} onChange={(e) => setAvailabilityForm({ ...availabilityForm, ends_time: e.target.value })}
                   style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' }} />
          </div>
        </div>
      </CrudModal>
    </div>
  );
}
