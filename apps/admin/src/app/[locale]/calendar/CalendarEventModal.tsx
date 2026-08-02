'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';

interface ActivityType {
  id: number;
  name: string;
  color: string | null;
  duration_minutes: number;
  default_space_id: number | null;
  default_trainer_membership_id: number | null;
}
interface Space { id: number; name: string }
interface Trainer { gym_membership_id: number; name: string }

export interface CalendarEventForm {
  title: string;
  activity_type_id: string;
  space_id: string;
  trainer_membership_id: string;
  color: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  description: string;
  status: string;
}

interface Props {
  open: boolean;
  editing: { id: number } | null;
  initialForm: CalendarEventForm;
  activityTypes: ActivityType[];
  spaces: Space[];
  trainers: Trainer[];
  onSave: (form: CalendarEventForm) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel: () => void;
  canWrite: boolean;
}

const STATUSES = ['draft', 'scheduled', 'completed', 'cancelled'] as const;

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6,
  border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff',
};

export function CalendarEventModal({
  open, editing, initialForm, activityTypes, spaces, trainers,
  onSave, onDelete, onCancel, canWrite,
}: Props) {
  const t = useTranslations('calendar');
  const [form, setForm] = useState<CalendarEventForm>(initialForm);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setForm(initialForm); setError(null); setSaving(false); setDeleting(false); }
  }, [open, initialForm]);

  function field(key: keyof CalendarEventForm, value: any) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function onActivityTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    field('activity_type_id', id);
    if (!id) return;
    const at = activityTypes.find((a) => String(a.id) === id);
    if (!at) return;
    if (at.color) field('color', at.color);
    if (at.default_space_id) field('space_id', String(at.default_space_id));
    if (at.default_trainer_membership_id) field('trainer_membership_id', String(at.default_trainer_membership_id));
    // Recalculate ends_at from starts_at + duration_minutes
    if (form.starts_at && at.duration_minutes) {
      const start = new Date(form.starts_at);
      if (!isNaN(start.getTime())) {
        const end = new Date(start.getTime() + at.duration_minutes * 60000);
        field('ends_at', toDateTimeLocal(end));
      }
    }
  }

  async function handleSave() {
    if (!form.title.trim()) { setError(t('error_title_required')); return; }
    if (!form.all_day && form.starts_at && form.ends_at && new Date(form.ends_at) <= new Date(form.starts_at)) {
      setError(t('error_end_before_start')); return;
    }
    setSaving(true); setError(null);
    try { await onSave(form); }
    catch (err: any) { setError(err.message ?? t('error_generic')); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!onDelete) return;
    setDeleting(true);
    try { await onDelete(); }
    catch (err: any) { setError(err.message ?? t('error_generic')); setDeleting(false); }
  }

  const title = editing ? t('modal_edit') : t('modal_create');

  return (
    <CrudModal
      open={open}
      title={title}
      error={error}
      saving={saving || deleting}
      cancelLabel={t('cancel')}
      saveLabel={saving ? t('saving') : t('save_changes')}
      saveDisabled={!canWrite}
      onCancel={onCancel}
      onSave={handleSave}
      extraFooter={editing && onDelete && canWrite ? (
        <button
          onClick={handleDelete}
          disabled={deleting}
          style={{ marginRight: 'auto', padding: '8px 16px', background: '#c0392b', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}
        >
          {deleting ? t('deleting') : t('delete')}
        </button>
      ) : undefined}
    >
      <FormLabel>{t('event_title')} *</FormLabel>
      <FormInput value={form.title} onChange={(e) => field('title', e.target.value)} autoFocus disabled={!canWrite} />

      <FormLabel>{t('event_activity_type')}</FormLabel>
      <select value={form.activity_type_id} onChange={onActivityTypeChange} style={selectStyle} disabled={!canWrite}>
        <option value="">—</option>
        {activityTypes.map((at) => <option key={at.id} value={at.id}>{at.name}</option>)}
      </select>

      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <FormLabel>{t('event_starts')}</FormLabel>
          <FormInput type={form.all_day ? 'date' : 'datetime-local'} value={form.starts_at}
            onChange={(e) => field('starts_at', e.target.value)} disabled={!canWrite} />
        </div>
        <div style={{ flex: 1 }}>
          <FormLabel>{t('event_ends')}</FormLabel>
          <FormInput type={form.all_day ? 'date' : 'datetime-local'} value={form.ends_at}
            onChange={(e) => field('ends_at', e.target.value)} disabled={!canWrite} />
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={form.all_day} onChange={(e) => field('all_day', e.target.checked)} disabled={!canWrite} />
        <span style={{ fontSize: 14 }}>{t('event_all_day')}</span>
      </label>

      <FormLabel>{t('event_space')}</FormLabel>
      <select value={form.space_id} onChange={(e) => field('space_id', e.target.value)} style={selectStyle} disabled={!canWrite}>
        <option value="">—</option>
        {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>

      <FormLabel>{t('event_trainer')}</FormLabel>
      <select value={form.trainer_membership_id} onChange={(e) => field('trainer_membership_id', e.target.value)} style={selectStyle} disabled={!canWrite}>
        <option value="">—</option>
        {trainers.map((tr) => <option key={tr.gym_membership_id} value={tr.gym_membership_id}>{tr.name}</option>)}
      </select>

      <FormLabel>{t('event_status')}</FormLabel>
      <select value={form.status} onChange={(e) => field('status', e.target.value)} style={selectStyle} disabled={!canWrite}>
        {STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
      </select>

      <FormLabel>{t('event_color')}</FormLabel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input type="color" value={form.color || '#3b82f6'} onChange={(e) => field('color', e.target.value)}
          disabled={!canWrite} style={{ width: 40, height: 36, border: 'none', cursor: 'pointer', padding: 0 }} />
        <button onClick={() => field('color', '')} style={{ fontSize: 13, color: '#888', background: 'none', border: 'none', cursor: 'pointer' }}>
          {t('color_clear')}
        </button>
      </div>

      <FormLabel>{t('event_description')}</FormLabel>
      <textarea
        value={form.description}
        onChange={(e) => field('description', e.target.value)}
        rows={3}
        disabled={!canWrite}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
      />
    </CrudModal>
  );
}

export function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function toDateLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const EMPTY_FORM: CalendarEventForm = {
  title: '', activity_type_id: '', space_id: '', trainer_membership_id: '',
  color: '', starts_at: '', ends_at: '', all_day: false, description: '', status: 'scheduled',
};
