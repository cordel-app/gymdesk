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
import { toDateTimeLocal, toDateLocal, EMPTY_FORM, type CalendarEventForm } from './CalendarEventModal';
import { EventDetailsPanel, type EventMeta } from './EventDetailsPanel';
import { ClassSessionDetailPanel } from './ClassSessionDetailPanel';

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

const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 800;
const DEFAULT_PANEL_WIDTH = 380;
const STORAGE_KEY = 'calendar-panel-width';

function readStoredWidth(): number {
  try {
    const v = sessionStorage.getItem(STORAGE_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= MIN_PANEL_WIDTH && n <= MAX_PANEL_WIDTH) return n;
    }
  } catch {}
  return DEFAULT_PANEL_WIDTH;
}

export default function CalendarPage() {
  const t = useTranslations('calendar');
  const router = useRouter();
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();
  const calendarRef = useRef<InstanceType<typeof FullCalendar>>(null);
  const dblClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClickDateStrRef = useRef<string | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const [panelWidth, setPanelWidth] = useState<number>(DEFAULT_PANEL_WIDTH);

  useEffect(() => {
    setPanelWidth(readStoredWidth());
  }, []);

  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [trainers, setTrainers] = useState<Trainer[]>([]);

  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [filterId, setFilterId] = useState('');

  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingMeta, setEditingMeta] = useState<EventMeta | null>(null);
  const [initialForm, setInitialForm] = useState<CalendarEventForm>(EMPTY_FORM);

  // Class session panel
  const [sessionPanelId, setSessionPanelId] = useState<number | null>(null);

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

      Promise.all([
        apiFetch<any[]>(`/calendar-events?${params}`),
        apiFetch<any[]>(`/class-sessions?${params}`),
      ])
        .then(([calEvents, sessions]) => {
          const calMapped = calEvents.map((e) => ({
            id: `ce-${e.id}`,
            title: e.title,
            start: e.starts_at,
            end: e.ends_at,
            allDay: !!e.all_day,
            backgroundColor: e.color || e.activity_type_color || STATUS_COLORS[e.status] || '#3b82f6',
            borderColor:     e.color || e.activity_type_color || STATUS_COLORS[e.status] || '#3b82f6',
            editable: true,
            extendedProps: { ...e, _type: 'event' },
          }));
          const sessionMapped = sessions.map((s) => ({
            id: `cs-${s.id}`,
            title: s.class_type_name,
            start: s.starts_at,
            end: s.ends_at,
            allDay: false,
            backgroundColor: s.activity_type_color || STATUS_COLORS[s.status] || '#8b5cf6',
            borderColor:     s.activity_type_color || STATUS_COLORS[s.status] || '#8b5cf6',
            // Sessions use a different time-change flow; disable FC drag/resize
            editable: false,
            extendedProps: { ...s, _type: 'session' },
          }));
          successCb([...calMapped, ...sessionMapped]);
        })
        .catch(failureCb);
    },
    [activeGymId, filterMode, filterId, apiFetch],
  );

  function refetch() {
    calendarRef.current?.getApi().refetchEvents();
  }

  function openCreate(start: Date, end?: Date) {
    const allDay = !end;
    setSessionPanelId(null);
    setEditingId(null);
    setEditingMeta(null);
    setInitialForm({
      ...EMPTY_FORM,
      starts_at: allDay ? toDateLocal(start) : toDateTimeLocal(start),
      ends_at:   allDay ? toDateLocal(start)  : toDateTimeLocal(end ?? new Date(start.getTime() + 60 * 60000)),
      all_day:   allDay,
    });
    setPanelOpen(true);
  }

  function handleEventClick(info: any) {
    const e = info.event.extendedProps;
    if (e._type === 'session') {
      // Open instance management panel
      setSessionPanelId(Number(e.id));
      setPanelOpen(false);
      setEditingId(null);
    } else {
      openEdit(info.event);
    }
  }

  function openEdit(event: any) {
    const e = event.extendedProps;
    const allDay = !!e.all_day;
    setSessionPanelId(null);
    setEditingId(e.id);
    setEditingMeta({
      created_by_name:  e.created_by_name  ?? null,
      created_at:       e.created_at       ?? null,
      modified_by_name: e.modified_by_name ?? null,
      updated_at:       e.updated_at       ?? null,
      deleted_by_name:  e.deleted_by_name  ?? null,
      deleted_at:       e.deleted_at       ?? null,
    });
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
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
    setEditingId(null);
    setEditingMeta(null);
  }

  function closeSessionPanel() {
    setSessionPanelId(null);
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
      // editingId is the raw numeric id from extendedProps (not prefixed)
      await apiFetch(`/calendar-events/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await apiFetch('/calendar-events', { method: 'POST', body: JSON.stringify(body) });
    }
    closePanel();
    refetch();
  }

  async function handleDelete() {
    if (!editingId) return;
    await apiFetch(`/calendar-events/${editingId}`, { method: 'DELETE' });
    closePanel();
    refetch();
  }

  async function handleDrop(info: any) {
    // Only calendar events are draggable (sessions have editable:false)
    const rawId = String(info.event.id).replace(/^ce-/, '');
    try {
      await apiFetch(`/calendar-events/${rawId}`, {
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

  function handleDateClick(info: any) {
    const api = calendarRef.current?.getApi();
    const viewType = api?.view.type;

    if (viewType === 'dayGridMonth' || viewType === 'timeGridWeek') {
      const dateStr = info.dateStr.slice(0, 10);

      if (lastClickDateStrRef.current === dateStr && dblClickTimerRef.current !== null) {
        // Double-click: navigate to Day view for the clicked date
        clearTimeout(dblClickTimerRef.current);
        dblClickTimerRef.current = null;
        lastClickDateStrRef.current = null;
        api?.changeView('timeGridDay', info.date);
      } else {
        // First click: start 300ms timer before executing single-click action
        if (dblClickTimerRef.current !== null) clearTimeout(dblClickTimerRef.current);
        lastClickDateStrRef.current = dateStr;
        const clickedDate = info.date;
        dblClickTimerRef.current = setTimeout(() => {
          dblClickTimerRef.current = null;
          lastClickDateStrRef.current = null;
          openCreate(clickedDate);
        }, 300);
      }
    } else {
      openCreate(info.date);
    }
  }

  async function handleResize(info: any) {
    const rawId = String(info.event.id).replace(/^ce-/, '');
    try {
      await apiFetch(`/calendar-events/${rawId}`, {
        method: 'PUT',
        body: JSON.stringify({ ends_at: info.event.endStr }),
      });
      refetch();
    } catch (err: any) {
      toast(err.message);
      info.revert();
    }
  }

  function startPanelDrag(e: React.MouseEvent) {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: panelWidth };

    function onMove(ev: MouseEvent) {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - ev.clientX;
      const next = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, dragRef.current.startWidth + delta));
      setPanelWidth(next);
    }

    function onUp() {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setPanelWidth((w) => {
        try { sessionStorage.setItem(STORAGE_KEY, String(w)); } catch {}
        return w;
      });
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function handleResizeKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setPanelWidth((w) => {
        const next = Math.min(MAX_PANEL_WIDTH, w + 20);
        try { sessionStorage.setItem(STORAGE_KEY, String(next)); } catch {}
        return next;
      });
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setPanelWidth((w) => {
        const next = Math.max(MIN_PANEL_WIDTH, w - 20);
        try { sessionStorage.setItem(STORAGE_KEY, String(next)); } catch {}
        return next;
      });
    }
  }

  const filterOptions =
    filterMode === 'space'         ? spaces.map((s) => ({ id: String(s.id), label: s.name }))
    : filterMode === 'activity_type' ? activityTypes.map((a) => ({ id: String(a.id), label: a.name }))
    : filterMode === 'trainer'       ? trainers.map((tr) => ({ id: String(tr.gym_membership_id), label: tr.name }))
    : [];

  if (gymLoading) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)', gap: 12 }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        {canWrite && (
          <button onClick={() => openCreate(new Date())} style={btnStyle('#6c63ff')}>
            {t('new_event')}
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
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

      {/* Calendar + panel split view */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 0 }}>
        {/* Calendar */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
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
            dateClick={handleDateClick}
            eventClick={handleEventClick}
            eventDrop={handleDrop}
            eventResize={handleResize}
            eventContent={(arg: any) => {
              const e = arg.event.extendedProps;
              const isSession = e._type === 'session';
              const trainerName = isSession ? e.effective_trainer_name : e.trainer_name;
              return (
                <div style={{ padding: '2px 4px', fontSize: 12, overflow: 'hidden', cursor: 'pointer' }}>
                  <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {arg.event.title}
                    {isSession && (
                      <span style={{ fontWeight: 400, opacity: 0.85 }}>
                        {' '}({e.booked_count}/{e.effective_capacity})
                      </span>
                    )}
                  </div>
                  {trainerName && <div style={{ opacity: 0.85 }}>{trainerName}</div>}
                  {e.space_name && <div style={{ opacity: 0.85 }}>{e.space_name}</div>}
                </div>
              );
            }}
          />
        </div>

        {/* Calendar event details panel */}
        {panelOpen && !sessionPanelId && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('panel_resize_handle')}
              aria-valuenow={panelWidth}
              aria-valuemin={MIN_PANEL_WIDTH}
              aria-valuemax={MAX_PANEL_WIDTH}
              tabIndex={0}
              onMouseDown={startPanelDrag}
              onKeyDown={handleResizeKey}
              style={{
                width: 6, flexShrink: 0, cursor: 'col-resize',
                background: '#e5e7eb', transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#c7d2fe'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#e5e7eb'; }}
              onFocus={(e)       => { (e.currentTarget as HTMLDivElement).style.background = '#c7d2fe'; }}
              onBlur={(e)        => { (e.currentTarget as HTMLDivElement).style.background = '#e5e7eb'; }}
            />
            <div style={{ width: panelWidth, flexShrink: 0, overflow: 'hidden' }}>
              <EventDetailsPanel
                open={panelOpen}
                editing={editingId && editingMeta ? { id: editingId, meta: editingMeta } : null}
                initialForm={initialForm}
                activityTypes={activityTypes}
                spaces={spaces}
                trainers={trainers}
                onSave={handleSave}
                onDelete={handleDelete}
                onClose={closePanel}
                canWrite={canWrite}
              />
            </div>
          </>
        )}

        {/* Class session instance management panel */}
        {sessionPanelId && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('panel_resize_handle')}
              aria-valuenow={panelWidth}
              aria-valuemin={MIN_PANEL_WIDTH}
              aria-valuemax={MAX_PANEL_WIDTH}
              tabIndex={0}
              onMouseDown={startPanelDrag}
              onKeyDown={handleResizeKey}
              style={{
                width: 6, flexShrink: 0, cursor: 'col-resize',
                background: '#e5e7eb', transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#c7d2fe'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#e5e7eb'; }}
              onFocus={(e)       => { (e.currentTarget as HTMLDivElement).style.background = '#c7d2fe'; }}
              onBlur={(e)        => { (e.currentTarget as HTMLDivElement).style.background = '#e5e7eb'; }}
            />
            <div style={{ width: panelWidth, flexShrink: 0, overflow: 'hidden' }}>
              <ClassSessionDetailPanel
                sessionId={sessionPanelId}
                onClose={closeSessionPanel}
                onMutated={refetch}
                canWrite={canWrite}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
