'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useToast } from '@/components/Toast';
import { btnStyle } from '@/components/ui';
import {
  CalendarEventModal, toDateTimeLocal, toDateLocal,
  EMPTY_FORM, EMPTY_RECURRENCE, seriesFormToApi, seriesRowToForm,
  type CalendarEventForm,
} from './CalendarEventModal';

interface ActivityType {
  id: number; name: string; color: string | null;
  duration_minutes: number;
  default_space_id: number | null;
  default_trainer_membership_id: number | null;
}
interface Space { id: number; name: string }
interface Trainer { gym_membership_id: number; name: string }

type FilterMode = 'all' | 'space' | 'activity_type' | 'trainer';
type EditScope = 'this' | 'this_and_following' | 'entire_series';

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280',
  scheduled: '#3b82f6',
  completed: '#22c55e',
  cancelled: '#ef4444',
};

// ── Scope picker dialog ──────────────────────────────────────────────────────

function ScopeDialog({
  open, mode, value, onChange, onConfirm, onCancel,
}: {
  open: boolean;
  mode: 'edit' | 'delete';
  value: EditScope;
  onChange: (s: EditScope) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('calendar');
  if (!open) return null;

  const SCOPES: EditScope[] = ['this', 'this_and_following', 'entire_series'];

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 28, minWidth: 320, maxWidth: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
        <h3 style={{ margin: '0 0 18px', fontSize: 17, fontWeight: 600 }}>
          {mode === 'edit' ? t('scope_dialog_title_edit') : t('scope_dialog_title_delete')}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {SCOPES.map((s) => (
            <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 15 }}>
              <input type="radio" name="scope" value={s} checked={value === s} onChange={() => onChange(s)} />
              {t(`scope_${s}` as any)}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
          <button onClick={onCancel} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: 14 }}>
            {t('cancel')}
          </button>
          <button onClick={onConfirm} style={{ padding: '8px 18px', borderRadius: 6, border: 'none', background: mode === 'delete' ? '#c0392b' : '#6c63ff', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
            {t('scope_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const t = useTranslations('calendar');
  const router = useRouter();
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();
  const calendarRef = useRef<InstanceType<typeof FullCalendar>>(null);

  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [trainers, setTrainers] = useState<Trainer[]>([]);

  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [filterId, setFilterId] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingSeriesId, setEditingSeriesId] = useState<number | null>(null);
  const [initialForm, setInitialForm] = useState<CalendarEventForm>(EMPTY_FORM);

  // Scope picker state
  const [scopeDialogMode, setScopeDialogMode] = useState<'edit' | 'delete' | null>(null);
  const [selectedScope, setSelectedScope] = useState<EditScope>('this');

  const role = activeGym?.role ?? 'member';
  const canWrite = isSuperadmin || canWriteModule(role as any, 'TRAINING');

  useEffect(() => {
    if (!gymLoading && !activeGymId) router.replace(`/${locale}`);
  }, [gymLoading, activeGymId]);

  useEffect(() => {
    if (!activeGymId || gymLoading) return;
    Promise.all([
      apiFetch<ActivityType[]>('/activity-types?status=active'),
      apiFetch<Space[]>('/spaces'),
      apiFetch<Trainer[]>('/trainers'),
    ]).then(([at, sp, tr]) => {
      setActivityTypes(at);
      setSpaces(sp);
      setTrainers(tr);
    }).catch((err: any) => toast(err.message));
  }, [activeGymId, gymLoading]);

  const fetchEvents = useCallback(
    (info: any, successCb: (events: any[]) => void, failureCb: (err: Error) => void) => {
      if (!activeGymId) return;
      const params = new URLSearchParams({ from: info.startStr, to: info.endStr });
      if (filterMode === 'space'         && filterId) params.set('space_id', filterId);
      if (filterMode === 'activity_type' && filterId) params.set('activity_type_id', filterId);
      if (filterMode === 'trainer'       && filterId) params.set('trainer_membership_id', filterId);

      apiFetch<any[]>(`/calendar-events?${params}`)
        .then((events) =>
          successCb(events.map((e) => ({
            id: String(e.id),
            title: e.title,
            start: e.starts_at,
            end: e.ends_at,
            allDay: !!e.all_day,
            backgroundColor: e.color || e.activity_type_color || STATUS_COLORS[e.status] || '#3b82f6',
            borderColor:     e.color || e.activity_type_color || STATUS_COLORS[e.status] || '#3b82f6',
            extendedProps: e,
          })))
        )
        .catch(failureCb);
    },
    [activeGymId, filterMode, filterId, apiFetch],
  );

  function refetch() {
    calendarRef.current?.getApi().refetchEvents();
  }

  function buildForm(e: any): CalendarEventForm {
    const allDay = !!e.all_day;
    return {
      title:                 e.title ?? '',
      activity_type_id:      e.activity_type_id ? String(e.activity_type_id) : '',
      space_id:              e.space_id ? String(e.space_id) : '',
      trainer_membership_id: e.trainer_membership_id ? String(e.trainer_membership_id) : '',
      color:                 e.color ?? '',
      starts_at:             allDay ? toDateLocal(new Date(e.starts_at)) : toDateTimeLocal(new Date(e.starts_at)),
      ends_at:               allDay ? toDateLocal(new Date(e.ends_at))   : toDateTimeLocal(new Date(e.ends_at)),
      all_day:               allDay,
      description:           e.description ?? '',
      status:                e.status ?? 'scheduled',
      recurrence:            EMPTY_RECURRENCE,
    };
  }

  function openCreate(start: Date, end?: Date) {
    const allDay = !end;
    setEditingId(null);
    setEditingSeriesId(null);
    setSelectedScope('this');
    setInitialForm({
      ...EMPTY_FORM,
      starts_at: allDay ? toDateLocal(start) : toDateTimeLocal(start),
      ends_at:   allDay ? toDateLocal(start) : toDateTimeLocal(end ?? new Date(start.getTime() + 60 * 60000)),
      all_day:   allDay,
    });
    setModalOpen(true);
  }

  function openEdit(fcEvent: any) {
    const e = fcEvent.extendedProps;
    setEditingId(e.id);
    setEditingSeriesId(e.series_id ?? null);
    setInitialForm(buildForm(e));

    if (e.series_id) {
      // Show scope picker first
      setSelectedScope('this');
      setScopeDialogMode('edit');
    } else {
      setModalOpen(true);
    }
  }

  async function onScopeConfirmed() {
    // For entire_series / this_and_following: fetch the series to populate recurrence editor
    if (editingSeriesId && (selectedScope === 'entire_series' || selectedScope === 'this_and_following')) {
      try {
        const series = await apiFetch<any>(`/calendar-event-series/${editingSeriesId}`);
        setInitialForm((f) => ({ ...f, recurrence: seriesRowToForm(series) }));
      } catch {
        // fallback to empty recurrence; user can fill in
      }
    }
    setScopeDialogMode(null);
    setModalOpen(true);
  }

  function onScopeCancelled() {
    setScopeDialogMode(null);
    setEditingId(null);
    setEditingSeriesId(null);
  }

  async function handleSave(form: CalendarEventForm) {
    const body: Record<string, any> = {
      title:                 form.title.trim(),
      activity_type_id:      form.activity_type_id ? Number(form.activity_type_id) : null,
      space_id:              form.space_id ? Number(form.space_id) : null,
      trainer_membership_id: form.trainer_membership_id ? Number(form.trainer_membership_id) : null,
      color:                 form.color || null,
      starts_at:             form.all_day ? `${form.starts_at}T00:00:00` : form.starts_at,
      ends_at:               form.all_day ? `${form.ends_at}T23:59:59`   : form.ends_at,
      all_day:               form.all_day,
      description:           form.description || null,
      status:                form.status,
    };

    // Attach recurrence if relevant
    const rec = seriesFormToApi(form.recurrence);
    if (rec) body.recurrence = rec;

    if (editingId) {
      body.scope = selectedScope;
      await apiFetch(`/calendar-events/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await apiFetch('/calendar-events', { method: 'POST', body: JSON.stringify(body) });
    }

    setModalOpen(false);
    setSelectedScope('this');
    setEditingId(null);
    setEditingSeriesId(null);
    refetch();
  }

  function handleDeleteRequest() {
    // Called from CalendarEventModal delete button
    if (editingSeriesId) {
      setModalOpen(false);
      setSelectedScope('this');
      setScopeDialogMode('delete');
    } else {
      handleDeleteConfirmed();
    }
  }

  async function handleDeleteConfirmed() {
    if (!editingId) return;
    try {
      const url = editingSeriesId
        ? `/calendar-events/${editingId}?scope=${selectedScope}`
        : `/calendar-events/${editingId}`;
      await apiFetch(url, { method: 'DELETE' });
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
    setScopeDialogMode(null);
    setModalOpen(false);
    setEditingId(null);
    setEditingSeriesId(null);
    setSelectedScope('this');
    refetch();
  }

  async function handleDrop(info: any) {
    try {
      const body: Record<string, any> = {
        starts_at: info.event.startStr,
        ends_at:   info.event.endStr || info.event.startStr,
        all_day:   info.event.allDay,
      };
      // Recurring drop always affects only this occurrence
      if (info.event.extendedProps?.series_id) body.scope = 'this';
      await apiFetch(`/calendar-events/${info.event.id}`, { method: 'PUT', body: JSON.stringify(body) });
      refetch();
    } catch (err: any) {
      toast(err.message);
      info.revert();
    }
  }

  async function handleResize(info: any) {
    try {
      const body: Record<string, any> = { ends_at: info.event.endStr };
      if (info.event.extendedProps?.series_id) body.scope = 'this';
      await apiFetch(`/calendar-events/${info.event.id}`, { method: 'PUT', body: JSON.stringify(body) });
      refetch();
    } catch (err: any) {
      toast(err.message);
      info.revert();
    }
  }

  const filterOptions =
    filterMode === 'space'         ? spaces.map((s) => ({ id: String(s.id), label: s.name }))
    : filterMode === 'activity_type' ? activityTypes.map((a) => ({ id: String(a.id), label: a.name }))
    : filterMode === 'trainer'       ? trainers.map((tr) => ({ id: String(tr.gym_membership_id), label: tr.name }))
    : [];

  if (gymLoading) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        {canWrite && (
          <button onClick={() => openCreate(new Date())} style={btnStyle('#6c63ff')}>
            {t('new_event')}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {(['all', 'space', 'activity_type', 'trainer'] as FilterMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => { setFilterMode(mode); setFilterId(''); }}
            style={{
              padding: '6px 14px', borderRadius: 20, fontSize: 13, cursor: 'pointer',
              border: '1px solid #ccc',
              background: filterMode === mode ? '#6c63ff' : '#f5f5f5',
              color:      filterMode === mode ? '#fff'    : '#333',
            }}
          >
            {t(`filter_${mode}` as any)}
          </button>
        ))}
        {filterMode !== 'all' && filterOptions.length > 0 && (
          <select
            value={filterId}
            onChange={(e) => setFilterId(e.target.value)}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13 }}
          >
            <option value="">{t('filter_select_placeholder')}</option>
            {filterOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="timeGridDay"
          headerToolbar={{
            left:   'prev,next today',
            center: 'title',
            right:  'timeGridDay,timeGridWeek,dayGridMonth',
          }}
          buttonText={{
            today: t('today'),
            day:   t('view_day'),
            week:  t('view_week'),
            month: t('view_month'),
          }}
          events={fetchEvents}
          selectable={canWrite}
          editable={canWrite}
          eventResizableFromStart={canWrite}
          height="100%"
          select={(info: any) => openCreate(info.start, info.end)}
          dateClick={(info: any) => openCreate(info.date)}
          eventClick={(info: any) => openEdit(info.event)}
          eventDrop={handleDrop}
          eventResize={handleResize}
          eventContent={(arg: any) => {
            const e = arg.event.extendedProps;
            return (
              <div style={{ padding: '2px 4px', fontSize: 12, overflow: 'hidden', cursor: 'pointer' }}>
                <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {e.series_id && <span style={{ marginRight: 4, opacity: 0.8 }}>↻</span>}
                  {arg.event.title}
                </div>
                {e.trainer_name && <div style={{ opacity: 0.85 }}>{e.trainer_name}</div>}
                {e.space_name   && <div style={{ opacity: 0.85 }}>{e.space_name}</div>}
              </div>
            );
          }}
        />
      </div>

      <ScopeDialog
        open={scopeDialogMode !== null}
        mode={scopeDialogMode ?? 'edit'}
        value={selectedScope}
        onChange={setSelectedScope}
        onConfirm={scopeDialogMode === 'delete' ? handleDeleteConfirmed : onScopeConfirmed}
        onCancel={onScopeCancelled}
      />

      <CalendarEventModal
        open={modalOpen}
        editing={editingId ? { id: editingId } : null}
        initialForm={initialForm}
        activityTypes={activityTypes}
        spaces={spaces}
        trainers={trainers}
        editScope={editingId ? selectedScope : undefined}
        onSave={handleSave}
        onDelete={editingId ? handleDeleteRequest : undefined}
        onCancel={() => {
          setModalOpen(false);
          setEditingId(null);
          setEditingSeriesId(null);
          setSelectedScope('this');
        }}
        canWrite={canWrite}
      />
    </div>
  );
}
