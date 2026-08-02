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

export type RecurrenceType = 'never' | 'daily' | 'weekdays' | 'weekends' | 'weekly' | 'monthly' | 'yearly';
export type EndType = 'never' | 'on_date' | 'after_n';
export type Ordinal = 'first' | 'second' | 'third' | 'fourth' | 'last';
export type WeekdayCode = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export interface RecurrenceForm {
  type: RecurrenceType;
  interval: number;
  weekdays: WeekdayCode[];
  monthlyOrdinal: Ordinal;
  monthlyWeekday: WeekdayCode;
  endType: EndType;
  endDate: string;
  endCount: number;
}

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
  recurrence: RecurrenceForm;
}

interface Props {
  open: boolean;
  editing: { id: number } | null;
  initialForm: CalendarEventForm;
  activityTypes: ActivityType[];
  spaces: Space[];
  trainers: Trainer[];
  editScope?: string;
  onSave: (form: CalendarEventForm) => Promise<void>;
  onDelete?: () => void;
  onCancel: () => void;
  canWrite: boolean;
}

const STATUSES = ['draft', 'scheduled', 'completed', 'cancelled'] as const;
const WEEKDAY_CODES: WeekdayCode[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ORDINALS: Ordinal[] = ['first', 'second', 'third', 'fourth', 'last'];

export const EMPTY_RECURRENCE: RecurrenceForm = {
  type: 'never',
  interval: 1,
  weekdays: [],
  monthlyOrdinal: 'first',
  monthlyWeekday: 'Mon',
  endType: 'never',
  endDate: '',
  endCount: 10,
};

export function seriesFormToApi(r: RecurrenceForm) {
  if (r.type === 'never') return undefined;
  return {
    type: r.type,
    interval: r.interval,
    weekdays: r.type === 'weekly' && r.weekdays.length > 0 ? r.weekdays.join(',') : undefined,
    monthly_ordinal: r.type === 'monthly' ? r.monthlyOrdinal : undefined,
    monthly_weekday: r.type === 'monthly' ? r.monthlyWeekday : undefined,
    end_type: r.endType,
    end_date:  r.endType === 'on_date' ? r.endDate  : undefined,
    end_count: r.endType === 'after_n' ? r.endCount : undefined,
  };
}

export function seriesRowToForm(s: any): RecurrenceForm {
  return {
    type: s.recurrence_type ?? 'never',
    interval: s.recurrence_interval ?? 1,
    weekdays: s.weekdays ? s.weekdays.split(',') : [],
    monthlyOrdinal: s.monthly_ordinal ?? 'first',
    monthlyWeekday: s.monthly_weekday ?? 'Mon',
    endType: s.end_type ?? 'never',
    endDate: s.end_date ?? '',
    endCount: s.end_count ?? 10,
  };
}

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6,
  border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff',
};

// ── RecurrenceEditor ────────────────────────────────────────────────────────

function RecurrenceEditor({
  value, onChange, disabled,
}: { value: RecurrenceForm; onChange: (r: RecurrenceForm) => void; disabled: boolean }) {
  const t = useTranslations('calendar');

  function set<K extends keyof RecurrenceForm>(key: K, val: RecurrenceForm[K]) {
    onChange({ ...value, [key]: val });
  }

  function toggleWeekday(day: WeekdayCode) {
    const next = value.weekdays.includes(day)
      ? value.weekdays.filter((d) => d !== day)
      : [...value.weekdays, day];
    set('weekdays', next);
  }

  const showInterval  = value.type === 'weekly' || value.type === 'yearly' || value.type === 'daily';
  const showWeekdays  = value.type === 'weekly';
  const showMonthly   = value.type === 'monthly';

  return (
    <div style={{ marginTop: 4 }}>
      <FormLabel>{t('recurrence_section')}</FormLabel>
      <select
        value={value.type}
        onChange={(e) => set('type', e.target.value as RecurrenceType)}
        style={selectStyle}
        disabled={disabled}
      >
        {(['never','daily','weekdays','weekends','weekly','monthly','yearly'] as RecurrenceType[]).map((rt) => (
          <option key={rt} value={rt}>{t(`recurrence_type_${rt}` as any)}</option>
        ))}
      </select>

      {value.type !== 'never' && (
        <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fafafa' }}>

          {showInterval && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 14, color: '#555' }}>{t('recurrence_interval_prefix')}</span>
              <input
                type="number" min={1} max={52}
                value={value.interval}
                onChange={(e) => set('interval', Math.max(1, parseInt(e.target.value, 10) || 1))}
                disabled={disabled}
                style={{ width: 60, padding: '6px 8px', borderRadius: 5, border: '1px solid #ccc', fontSize: 14, textAlign: 'center' }}
              />
              <span style={{ fontSize: 14, color: '#555' }}>
                {value.type === 'daily' && t('recurrence_interval_suffix_days')}
                {value.type === 'weekly' && t('recurrence_interval_suffix_weeks')}
                {value.type === 'yearly' && t('recurrence_interval_suffix_years')}
              </span>
            </div>
          )}

          {showWeekdays && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>{t('recurrence_weekdays_label')}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {WEEKDAY_CODES.map((day) => {
                  const active = value.weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => !disabled && toggleWeekday(day)}
                      style={{
                        padding: '4px 10px', borderRadius: 14, fontSize: 13, cursor: disabled ? 'default' : 'pointer',
                        border: '1px solid', borderColor: active ? '#6c63ff' : '#ccc',
                        background: active ? '#6c63ff' : '#fff',
                        color: active ? '#fff' : '#333',
                      }}
                    >
                      {t(`recurrence_weekday_${day}` as any)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {showMonthly && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
              <select
                value={value.monthlyOrdinal}
                onChange={(e) => set('monthlyOrdinal', e.target.value as Ordinal)}
                disabled={disabled}
                style={{ ...selectStyle, width: 'auto', flex: 1 }}
              >
                {ORDINALS.map((o) => (
                  <option key={o} value={o}>{t(`recurrence_ordinal_${o}` as any)}</option>
                ))}
              </select>
              <select
                value={value.monthlyWeekday}
                onChange={(e) => set('monthlyWeekday', e.target.value as WeekdayCode)}
                disabled={disabled}
                style={{ ...selectStyle, width: 'auto', flex: 1 }}
              >
                {WEEKDAY_CODES.map((day) => (
                  <option key={day} value={day}>{t(`recurrence_weekday_${day}` as any)}</option>
                ))}
              </select>
            </div>
          )}

          {/* End condition */}
          <div style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>{t('recurrence_end_label')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(['never', 'on_date', 'after_n'] as EndType[]).map((et) => (
              <label key={et} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'default' : 'pointer', fontSize: 14 }}>
                <input
                  type="radio"
                  checked={value.endType === et}
                  onChange={() => !disabled && set('endType', et)}
                  disabled={disabled}
                />
                <span>{t(`recurrence_end_${et}` as any)}</span>
                {et === 'on_date' && value.endType === 'on_date' && (
                  <input
                    type="date"
                    value={value.endDate}
                    onChange={(e) => set('endDate', e.target.value)}
                    disabled={disabled}
                    style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid #ccc', fontSize: 14 }}
                  />
                )}
                {et === 'after_n' && value.endType === 'after_n' && (
                  <>
                    <input
                      type="number" min={1} max={999}
                      value={value.endCount}
                      onChange={(e) => set('endCount', Math.max(1, parseInt(e.target.value, 10) || 1))}
                      disabled={disabled}
                      style={{ width: 64, padding: '4px 8px', borderRadius: 5, border: '1px solid #ccc', fontSize: 14, textAlign: 'center' }}
                    />
                    <span style={{ color: '#555' }}>{t('recurrence_end_occurrences')}</span>
                  </>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── CalendarEventModal ───────────────────────────────────────────────────────

export function CalendarEventModal({
  open, editing, initialForm, activityTypes, spaces, trainers,
  editScope, onSave, onDelete, onCancel, canWrite,
}: Props) {
  const t = useTranslations('calendar');
  const [form, setForm] = useState<CalendarEventForm>(initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setForm(initialForm); setError(null); setSaving(false); }
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

  // Show recurrence editor when creating, or when editing with a series scope
  const showRecurrence = !editing || editScope === 'entire_series' || editScope === 'this_and_following';

  return (
    <CrudModal
      open={open}
      title={editing ? t('modal_edit') : t('modal_create')}
      error={error}
      saving={saving}
      cancelLabel={t('cancel')}
      saveLabel={saving ? t('saving') : t('save_changes')}
      saveDisabled={!canWrite}
      onCancel={onCancel}
      onSave={handleSave}
      extraFooter={editing && onDelete && canWrite ? (
        <button
          onClick={onDelete}
          style={{ marginRight: 'auto', padding: '8px 16px', background: '#c0392b', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}
        >
          {t('delete')}
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

      {showRecurrence && (
        <RecurrenceEditor
          value={form.recurrence}
          onChange={(r) => field('recurrence', r)}
          disabled={!canWrite}
        />
      )}
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
  recurrence: EMPTY_RECURRENCE,
};
