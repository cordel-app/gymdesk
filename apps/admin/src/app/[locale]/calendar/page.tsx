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
import { CalendarEventModal, toDateTimeLocal, toDateLocal, EMPTY_FORM, type CalendarEventForm } from './CalendarEventModal';

interface ActivityType {
  id: number; name: string; color: string | null;
  duration_minutes: number;
  default_space_id: number | null;
  default_trainer_membership_id: number | null;
}
interface Space { id: number; name: string }
interface Trainer { gym_membership_id: number; name: string }

type FilterMode = 'all' | 'space' | 'activity_type' | 'trainer';

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280',
  scheduled: '#3b82f6',
  completed: '#22c55e',
  cancelled: '#ef4444',
};

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
  const [initialForm, setInitialForm] = useState<CalendarEventForm>(EMPTY_FORM);

  const role = activeGym?.role ?? 'member';
  const canWrite = isSuperadmin || canWriteModule(role as any, 'CALENDAR');

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

  function openCreate(start: Date, end?: Date) {
    const allDay = !end;
    setEditingId(null);
    setInitialForm({
      ...EMPTY_FORM,
      starts_at: allDay ? toDateLocal(start) : toDateTimeLocal(start),
      ends_at:   allDay ? toDateLocal(start)  : toDateTimeLocal(end ?? new Date(start.getTime() + 60 * 60000)),
      all_day:   allDay,
    });
    setModalOpen(true);
  }

  function openEdit(event: any) {
    const e = event.extendedProps;
    const allDay = !!e.all_day;
    setEditingId(e.id);
    setInitialForm({
      title:                 e.title,
      activity_type_id:      e.activity_type_id ? String(e.activity_type_id) : '',
      space_id:              e.space_id ? String(e.space_id) : '',
      trainer_membership_id: e.trainer_membership_id ? String(e.trainer_membership_id) : '',
      color:                 e.color ?? '',
      starts_at:             allDay ? toDateLocal(new Date(e.starts_at)) : toDateTimeLocal(new Date(e.starts_at)),
      ends_at:               allDay ? toDateLocal(new Date(e.ends_at))   : toDateTimeLocal(new Date(e.ends_at)),
      all_day:               allDay,
      description:           e.description ?? '',
      status:                e.status ?? 'scheduled',
    });
    setModalOpen(true);
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
    if (editingId) {
      await apiFetch(`/calendar-events/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await apiFetch('/calendar-events', { method: 'POST', body: JSON.stringify(body) });
    }
    setModalOpen(false);
    refetch();
  }

  async function handleDelete() {
    if (!editingId) return;
    await apiFetch(`/calendar-events/${editingId}`, { method: 'DELETE' });
    setModalOpen(false);
    refetch();
  }

  async function handleDrop(info: any) {
    try {
      await apiFetch(`/calendar-events/${info.event.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          starts_at: info.event.startStr,
          ends_at:   info.event.endStr || info.event.startStr,
          all_day:   info.event.allDay,
        }),
      });
      refetch();
    } catch (err: any) {
      toast(err.message);
      info.revert();
    }
  }

  async function handleResize(info: any) {
    try {
      await apiFetch(`/calendar-events/${info.event.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ends_at: info.event.endStr }),
      });
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
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        {canWrite && (
          <button onClick={() => openCreate(new Date())} style={btnStyle('#6c63ff')}>
            {t('new_event')}
          </button>
        )}
      </div>

      {/* Filter bar */}
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

      {/* Calendar */}
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
                  {arg.event.title}
                </div>
                {e.trainer_name && <div style={{ opacity: 0.85 }}>{e.trainer_name}</div>}
                {e.space_name   && <div style={{ opacity: 0.85 }}>{e.space_name}</div>}
              </div>
            );
          }}
        />
      </div>

      <CalendarEventModal
        open={modalOpen}
        editing={editingId ? { id: editingId } : null}
        initialForm={initialForm}
        activityTypes={activityTypes}
        spaces={spaces}
        trainers={trainers}
        onSave={handleSave}
        onDelete={editingId ? handleDelete : undefined}
        onCancel={() => setModalOpen(false)}
        canWrite={canWrite}
      />
    </div>
  );
}
