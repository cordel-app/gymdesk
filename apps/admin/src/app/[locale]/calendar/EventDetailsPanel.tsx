'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FormLabel, FormInput } from '@/components/CrudModal';
import { toDateTimeLocal, type CalendarEventForm } from './CalendarEventModal';

interface ActivityType {
  id: number; name: string; color: string | null;
  duration_minutes: number;
  default_space_id: number | null;
  default_trainer_membership_id: number | null;
}
interface Space { id: number; name: string }
interface Trainer { gym_membership_id: number; name: string }

export interface EventMeta {
  created_by_name: string | null;
  created_at: string | null;
  modified_by_name: string | null;
  updated_at: string | null;
  deleted_by_name: string | null;
  deleted_at: string | null;
}

interface Props {
  open: boolean;
  editing: { id: number; meta: EventMeta } | null;
  initialForm: CalendarEventForm;
  activityTypes: ActivityType[];
  spaces: Space[];
  trainers: Trainer[];
  onSave: (form: CalendarEventForm) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
  canWrite: boolean;
}

const STATUSES = ['draft', 'scheduled', 'completed', 'cancelled'] as const;

type DeleteState = 'idle' | 'confirming' | 'deleting';

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6,
  border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box',
  background: 'var(--gd-input-bg, #fff)',
  color: 'var(--gd-text, inherit)',
};

function MetaRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 13, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function EventDetailsPanel({
  open, editing, initialForm, activityTypes, spaces, trainers,
  onSave, onDelete, onClose, canWrite,
}: Props) {
  const t = useTranslations('calendar');
  const [form, setForm] = useState<CalendarEventForm>(initialForm);
  const [saving, setSaving] = useState(false);
  const [deleteState, setDeleteState] = useState<DeleteState>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(initialForm);
      setError(null);
      setSaving(false);
      setDeleteState('idle');
    }
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
        field('ends_at', toDateTimeLocal(new Date(start.getTime() + at.duration_minutes * 60000)));
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

  async function handleConfirmDelete() {
    setDeleteState('deleting');
    try { await onDelete(); }
    catch (err: any) { setError(err.message ?? t('error_generic')); setDeleteState('idle'); }
  }

  if (!open) return null;

  const isNew = !editing;
  const meta = editing?.meta ?? null;
  const busy = saving || deleteState === 'deleting';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      borderLeft: '1px solid var(--gd-border, #e5e7eb)',
      background: 'var(--gd-card-bg, var(--gd-bg-secondary, #f9fafb))',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 16px', borderBottom: '1px solid var(--gd-border, #e5e7eb)',
        flexShrink: 0,
      }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          {isNew ? t('modal_create') : t('modal_edit')}
        </h3>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: '#9ca3af', padding: '2px 4px' }}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {/* Body — scrollable */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {error && (
          <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 6, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* Delete confirmation */}
        {deleteState === 'confirming' && (
          <div style={{
            marginBottom: 16, padding: '14px', borderRadius: 8,
            border: '1px solid #fca5a5', background: '#fef2f2',
          }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4, color: '#991b1b' }}>{t('delete_confirm_title')}</div>
            <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 12 }}>{t('delete_confirm_message')}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setDeleteState('idle')}
                style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer' }}
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleConfirmDelete}
                style={{ flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                {t('delete')}
              </button>
            </div>
          </div>
        )}

        {/* Form */}
        <FormLabel>{t('event_title')} *</FormLabel>
        <FormInput value={form.title} onChange={(e) => field('title', e.target.value)} autoFocus disabled={!canWrite || busy} />

        <FormLabel>{t('event_activity_type')}</FormLabel>
        <select value={form.activity_type_id} onChange={onActivityTypeChange} style={selectStyle} disabled={!canWrite || busy}>
          <option value="">—</option>
          {activityTypes.map((at) => <option key={at.id} value={at.id}>{at.name}</option>)}
        </select>

        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <div style={{ flex: 1 }}>
            <FormLabel>{t('event_starts')}</FormLabel>
            <FormInput type={form.all_day ? 'date' : 'datetime-local'} value={form.starts_at}
              onChange={(e) => field('starts_at', e.target.value)} disabled={!canWrite || busy} />
          </div>
          <div style={{ flex: 1 }}>
            <FormLabel>{t('event_ends')}</FormLabel>
            <FormInput type={form.all_day ? 'date' : 'datetime-local'} value={form.ends_at}
              onChange={(e) => field('ends_at', e.target.value)} disabled={!canWrite || busy} />
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 14px', cursor: 'pointer', fontSize: 14 }}>
          <input type="checkbox" checked={form.all_day} onChange={(e) => field('all_day', e.target.checked)} disabled={!canWrite || busy} />
          {t('event_all_day')}
        </label>

        <FormLabel>{t('event_space')}</FormLabel>
        <select value={form.space_id} onChange={(e) => field('space_id', e.target.value)} style={selectStyle} disabled={!canWrite || busy}>
          <option value="">—</option>
          {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <div style={{ marginTop: 12 }}><FormLabel>{t('event_trainer')}</FormLabel></div>
        <select value={form.trainer_membership_id} onChange={(e) => field('trainer_membership_id', e.target.value)} style={selectStyle} disabled={!canWrite || busy}>
          <option value="">—</option>
          {trainers.map((tr) => <option key={tr.gym_membership_id} value={tr.gym_membership_id}>{tr.name}</option>)}
        </select>

        <div style={{ marginTop: 12 }}><FormLabel>{t('event_status')}</FormLabel></div>
        <select value={form.status} onChange={(e) => field('status', e.target.value)} style={selectStyle} disabled={!canWrite || busy}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
        </select>

        <div style={{ marginTop: 12 }}><FormLabel>{t('event_color')}</FormLabel></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <input type="color" value={form.color || '#3b82f6'} onChange={(e) => field('color', e.target.value)}
            disabled={!canWrite || busy} style={{ width: 36, height: 32, border: 'none', cursor: 'pointer', padding: 0 }} />
          <button onClick={() => field('color', '')} disabled={busy}
            style={{ fontSize: 12, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer' }}>
            {t('color_clear')}
          </button>
        </div>

        <FormLabel>{t('event_description')}</FormLabel>
        <textarea
          value={form.description}
          onChange={(e) => field('description', e.target.value)}
          rows={3}
          disabled={!canWrite || busy}
          style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', marginBottom: 8 }}
        />

        {/* Metadata */}
        {meta && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--gd-border, #e5e7eb)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 }}>
              {t('metadata_section')}
            </div>
            <MetaRow label={t('metadata_created_by')} value={meta.created_by_name} />
            <MetaRow label={t('metadata_created_at')} value={formatDateTime(meta.created_at)} />
            <MetaRow label={t('metadata_updated_by')} value={meta.modified_by_name} />
            <MetaRow label={t('metadata_updated_at')} value={formatDateTime(meta.updated_at)} />
            <MetaRow label={t('metadata_deleted_by')} value={meta.deleted_by_name} />
            <MetaRow label={t('metadata_deleted_at')} value={formatDateTime(meta.deleted_at)} />
          </div>
        )}
      </div>

      {/* Footer actions */}
      {deleteState !== 'confirming' && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 8,
          padding: '12px 16px', borderTop: '1px solid var(--gd-border, #e5e7eb)', flexShrink: 0,
        }}>
          {canWrite && (
            <button
              onClick={handleSave}
              disabled={busy}
              style={{ width: '100%', padding: '9px 0', borderRadius: 6, border: 'none', background: '#6c63ff', color: '#fff', fontSize: 14, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1 }}
            >
              {saving ? t('saving') : (isNew ? t('save_changes') : t('save_changes'))}
            </button>
          )}
          {!isNew && canWrite && (
            <button
              onClick={() => setDeleteState('confirming')}
              disabled={busy}
              style={{ width: '100%', padding: '9px 0', borderRadius: 6, border: '1px solid #fca5a5', background: 'transparent', color: '#dc2626', fontSize: 14, cursor: busy ? 'not-allowed' : 'pointer' }}
            >
              {t('delete_event')}
            </button>
          )}
          <button
            onClick={onClose}
            disabled={busy}
            style={{ width: '100%', padding: '9px 0', borderRadius: 6, border: '1px solid #d1d5db', background: 'transparent', fontSize: 14, cursor: busy ? 'not-allowed' : 'pointer' }}
          >
            {t('cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
