'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

interface ActivityType { id: number; name: string; color: string | null }

interface ScheduleSession {
  id: number;
  activity_type_id: number;
  class_type_name: string;
  starts_at: string;
  ends_at: string;
  space_name: string | null;
  trainer_name: string | null;
  effective_capacity: number;
  booked_count: number;
  spots_left: number;
  my_booking_id: number | null;
  my_booking_status: 'booked' | 'waitlisted' | null;
  my_waitlist_position: number | null;
  my_shared_request_id: number | null;
  my_shared_request_status: 'pending' | 'approved' | null;
  access_locked: boolean;
  can_cancel: boolean;
  is_shareable: boolean;
  allows_shared_booking: boolean;
  availability_state:
    | 'UNAVAILABLE'
    | 'BOOKED_BY_MEMBER'
    | 'AVAILABLE'
    | 'WAITLISTED_BY_MEMBER'
    | 'SHARED_REQUESTED_BY_MEMBER'
    | 'SHARED_REQUEST_AVAILABLE'
    | 'WAITLIST_AVAILABLE'
    | 'FULL';
}

const STATE_COLORS: Record<ScheduleSession['availability_state'], string> = {
  UNAVAILABLE:                '#9ca3af',
  BOOKED_BY_MEMBER:           '#22c55e',
  AVAILABLE:                  '#3b82f6',
  WAITLISTED_BY_MEMBER:       '#f59e0b',
  SHARED_REQUESTED_BY_MEMBER: '#a78bfa',
  SHARED_REQUEST_AVAILABLE:   '#8b5cf6',
  WAITLIST_AVAILABLE:         '#f97316',
  FULL:                       '#ef4444',
};

export default function MemberCalendarPage() {
  const t = useTranslations('member_calendar');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading } = useApp();

  const calendarRef = useRef<InstanceType<typeof FullCalendar>>(null);
  const dblClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClickDateRef = useRef<string | null>(null);

  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([]);
  const [filterAtId, setFilterAtId] = useState('');
  const [selected, setSelected] = useState<ScheduleSession | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    apiFetch<ActivityType[]>('/activity-types?status=active')
      .then(setActivityTypes)
      .catch(() => {});
  }, [appLoading, isLinked, locale]);

  const fetchEvents = useCallback(
    (info: any, successCb: (events: any[]) => void, failureCb: (err: Error) => void) => {
      const params = new URLSearchParams({ from: info.startStr, to: info.endStr });
      if (filterAtId) params.set('activity_type_id', filterAtId);
      apiFetch<ScheduleSession[]>(`/me/schedule?${params}`)
        .then((sessions) =>
          successCb(
            sessions.map((s) => ({
              id: String(s.id),
              title: s.class_type_name,
              start: s.starts_at,
              end: s.ends_at,
              backgroundColor: STATE_COLORS[s.availability_state],
              borderColor:     STATE_COLORS[s.availability_state],
              extendedProps: s,
            })),
          ),
        )
        .catch(failureCb);
    },
    [filterAtId, apiFetch],
  );

  function refetch() {
    calendarRef.current?.getApi().refetchEvents();
  }

  function handleDateClick(info: any) {
    const api = calendarRef.current?.getApi();
    const viewType = api?.view.type;
    if (viewType === 'dayGridMonth' || viewType === 'timeGridWeek') {
      const dateStr = info.dateStr.slice(0, 10);
      if (lastClickDateRef.current === dateStr && dblClickTimerRef.current !== null) {
        clearTimeout(dblClickTimerRef.current);
        dblClickTimerRef.current = null;
        lastClickDateRef.current = null;
        api?.changeView('timeGridDay', info.date);
      } else {
        if (dblClickTimerRef.current !== null) clearTimeout(dblClickTimerRef.current);
        lastClickDateRef.current = dateStr;
        dblClickTimerRef.current = setTimeout(() => {
          dblClickTimerRef.current = null;
          lastClickDateRef.current = null;
        }, 300);
      }
    }
  }

  function handleEventClick(info: any) {
    setActionMsg(null);
    setSelected(info.event.extendedProps as ScheduleSession);
  }

  async function book() {
    if (!selected) return;
    setActionLoading(true);
    setActionMsg(null);
    try {
      await apiFetch('/me/bookings', {
        method: 'POST',
        body: JSON.stringify({ class_session_id: selected.id }),
      });
      refetch();
      setSelected(null);
    } catch (e: any) {
      setActionMsg(e.message ?? t('error_generic'));
    } finally { setActionLoading(false); }
  }

  async function cancelBooking() {
    if (!selected?.my_booking_id) return;
    setActionLoading(true);
    setActionMsg(null);
    try {
      await apiFetch(`/me/bookings/${selected.my_booking_id}`, { method: 'DELETE' });
      refetch();
      setSelected(null);
    } catch (e: any) {
      setActionMsg(e.message ?? t('error_generic'));
    } finally { setActionLoading(false); }
  }

  async function requestSharedTraining() {
    if (!selected) return;
    setActionLoading(true);
    setActionMsg(null);
    try {
      await apiFetch('/me/shared-training-requests', {
        method: 'POST',
        body: JSON.stringify({ class_session_id: selected.id }),
      });
      refetch();
      setSelected(null);
    } catch (e: any) {
      setActionMsg(e.message ?? t('error_generic'));
    } finally { setActionLoading(false); }
  }

  async function cancelSharedRequest() {
    if (!selected?.my_shared_request_id) return;
    setActionLoading(true);
    setActionMsg(null);
    try {
      await apiFetch(`/me/shared-training-requests/${selected.my_shared_request_id}`, { method: 'DELETE' });
      refetch();
      setSelected(null);
    } catch (e: any) {
      setActionMsg(e.message ?? t('error_generic'));
    } finally { setActionLoading(false); }
  }

  if (appLoading) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', boxSizing: 'border-box' }}>
      {/* Filter bar */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #e5e7eb', display: 'flex', gap: 8, overflowX: 'auto', flexShrink: 0 }}>
        <button
          onClick={() => { setFilterAtId(''); }}
          style={{
            padding: '4px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
            border: '1px solid #d1d5db',
            background: !filterAtId ? 'var(--gd-sidebar-selected-bg, #18181b)' : 'transparent',
            color:      !filterAtId ? '#fff' : 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          {t('filter_all')}
        </button>
        {activityTypes.map((at) => (
          <button
            key={at.id}
            onClick={() => setFilterAtId(String(at.id))}
            style={{
              padding: '4px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
              border: '1px solid #d1d5db',
              background: filterAtId === String(at.id) ? (at.color ?? 'var(--gd-sidebar-selected-bg, #18181b)') : 'transparent',
              color:      filterAtId === String(at.id) ? '#fff' : 'inherit',
              whiteSpace: 'nowrap',
            }}
          >
            {at.name}
          </button>
        ))}
      </div>

      {/* Calendar */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="timeGridDay"
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' }}
          height="100%"
          events={fetchEvents}
          eventClick={handleEventClick}
          dateClick={handleDateClick}
          eventContent={(arg: any) => {
            const s = arg.event.extendedProps as ScheduleSession;
            return (
              <div style={{ padding: '1px 3px', fontSize: 11, overflow: 'hidden', cursor: 'pointer' }}>
                <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {arg.event.title}
                </div>
                {s.trainer_name && (
                  <div style={{ opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.trainer_name}
                  </div>
                )}
              </div>
            );
          }}
        />
      </div>

      {/* Bottom-sheet action panel */}
      {selected && (
        <div
          onClick={() => { setSelected(null); setActionMsg(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60,
            display: 'flex', alignItems: 'flex-end',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%', background: 'var(--gd-sidebar-bg, #fff)',
              borderRadius: '16px 16px 0 0', padding: '20px 16px',
              boxShadow: '0 -4px 20px rgba(0,0,0,0.15)',
            }}
          >
            <div style={{ width: 36, height: 4, background: '#d1d5db', borderRadius: 2, margin: '0 auto 16px' }} />
            <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>{selected.class_type_name}</h3>
            <p style={{ margin: '0 0 2px', fontSize: 13, color: '#6b7280' }}>
              {new Date(selected.starts_at).toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {selected.trainer_name ? ` · ${selected.trainer_name}` : ''}
              {selected.space_name ? ` · ${selected.space_name}` : ''}
            </p>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: STATE_COLORS[selected.availability_state], fontWeight: 600 }}>
              {t(`state_${selected.availability_state.toLowerCase()}` as any)}
            </p>

            {actionMsg && (
              <p style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{actionMsg}</p>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {selected.availability_state === 'AVAILABLE' && (
                <button onClick={book} disabled={actionLoading} style={actionBtn('#3b82f6')}>
                  {t('action_book')}
                </button>
              )}
              {(selected.availability_state === 'WAITLIST_AVAILABLE') && (
                <button onClick={book} disabled={actionLoading} style={actionBtn('#f97316')}>
                  {t('action_join_waitlist')}
                </button>
              )}
              {selected.availability_state === 'BOOKED_BY_MEMBER' && selected.can_cancel && (
                <button onClick={cancelBooking} disabled={actionLoading} style={actionBtn('#ef4444')}>
                  {t('action_cancel_booking')}
                </button>
              )}
              {selected.availability_state === 'WAITLISTED_BY_MEMBER' && selected.can_cancel && (
                <button onClick={cancelBooking} disabled={actionLoading} style={actionBtn('#6b7280')}>
                  {t('action_leave_waitlist')}
                </button>
              )}
              {selected.availability_state === 'SHARED_REQUEST_AVAILABLE' && (
                <button onClick={requestSharedTraining} disabled={actionLoading} style={actionBtn('#8b5cf6')}>
                  {t('action_request_shared')}
                </button>
              )}
              {selected.availability_state === 'SHARED_REQUESTED_BY_MEMBER' && (
                <>
                  <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
                    {t('shared_request_status', { status: selected.my_shared_request_status ?? '' })}
                  </p>
                  {selected.my_shared_request_status === 'pending' && (
                    <button onClick={cancelSharedRequest} disabled={actionLoading} style={actionBtn('#6b7280')}>
                      {t('action_cancel_shared_request')}
                    </button>
                  )}
                </>
              )}
              <button
                onClick={() => { setSelected(null); setActionMsg(null); }}
                style={{ padding: '10px', borderRadius: 8, border: '1px solid #d1d5db', background: 'transparent', cursor: 'pointer', fontSize: 14 }}
              >
                {t('action_close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function actionBtn(bg: string): React.CSSProperties {
  return {
    padding: '12px', borderRadius: 8, border: 'none', background: bg,
    color: '#fff', fontWeight: 600, fontSize: 15, cursor: 'pointer', width: '100%',
  };
}
