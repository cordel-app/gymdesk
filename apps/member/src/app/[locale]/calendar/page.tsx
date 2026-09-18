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
import { weeklyToBusinessHours, holidayBackgroundEvents, type WeeklyShiftDTO, type HolidayDTO } from '@/lib/operatingHoursDisplay';

interface ActivityType { id: number; name: string; color: string | null }

interface Trainer { id: number; name: string }

type CalendarEventStatus = 'scheduled' | 'running' | 'completed' | 'cancelled';
type OccupancyStatus = 'available' | 'few_spots_left' | 'full' | 'unavailable';
type WaitlistStatus = 'disabled' | 'open' | 'closed';

interface ScheduleSession {
  id: number;
  activity_type_id: number;
  class_type_name: string;
  starts_at: string;
  ends_at: string;
  center_id: number | null;
  center_name: string | null;
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
  // #503 stage 5/7: unified read model, additive next to availability_state
  // (which stays the source of truth for booking-action buttons below).
  status: CalendarEventStatus;
  occupancy_status: OccupancyStatus;
  waitlist_status: WaitlistStatus;
  waitlist_count: number;
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
  const { isLinked, loading: appLoading, centers, activeCenterId } = useApp();

  const calendarRef = useRef<InstanceType<typeof FullCalendar>>(null);
  const dblClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClickDateRef = useRef<string | null>(null);

  const [activityTypes, setActivityTypes] = useState<ActivityType[]>([]);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [filterAtId, setFilterAtId] = useState('');

  // #503 stage 7: calendar-local center/trainer filters, independent from the
  // global CenterSwitcher (#478) — changing these must never affect Home,
  // Nutrition, Training Plans, My Bookings, or any other section. Default
  // center is initialized from the current global selection, if any; default
  // trainer is "all trainers". Kept in a compact panel behind a Filter button
  // rather than shown permanently, to preserve mobile header space.
  const [filterCenterId, setFilterCenterId] = useState('');
  const [filterTrainerId, setFilterTrainerId] = useState('');
  const [centerDefaultApplied, setCenterDefaultApplied] = useState(false);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [pendingCenterId, setPendingCenterId] = useState('');
  const [pendingTrainerId, setPendingTrainerId] = useState('');

  const [selected, setSelected] = useState<ScheduleSession | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [weeklyHours, setWeeklyHours] = useState<WeeklyShiftDTO[]>([]);
  const [holidays, setHolidays] = useState<HolidayDTO[]>([]);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    apiFetch<ActivityType[]>('/activity-types?status=active')
      .then(setActivityTypes)
      .catch(() => {});
    apiFetch<Trainer[]>('/me/trainers')
      .then(setTrainers)
      .catch(() => {});
    // #418: Operating Hours & Holidays — greys out closed/out-of-hours slots.
    // Non-fatal if the feature isn't configured/enabled for this gym.
    apiFetch<{ weekly: WeeklyShiftDTO[]; holidays: HolidayDTO[] }>('/me/operating-hours')
      .then(({ weekly, holidays }) => { setWeeklyHours(weekly); setHolidays(holidays); })
      .catch(() => {});
  }, [appLoading, isLinked, locale]);

  // Apply the global center selection as this filter's default exactly once,
  // as soon as it becomes known — never again afterward, so a later change to
  // the global CenterSwitcher doesn't silently override a member's own choice.
  useEffect(() => {
    if (!centerDefaultApplied && activeCenterId != null) {
      setFilterCenterId(String(activeCenterId));
      setCenterDefaultApplied(true);
    }
  }, [activeCenterId, centerDefaultApplied]);

  const businessHours = weeklyToBusinessHours(weeklyHours);
  const filtersActive = !!filterCenterId || !!filterTrainerId;

  const fetchEvents = useCallback(
    (info: any, successCb: (events: any[]) => void, failureCb: (err: Error) => void) => {
      const params = new URLSearchParams({ from: info.startStr, to: info.endStr });
      if (filterAtId) params.set('activity_type_id', filterAtId);
      if (filterCenterId) params.set('center_id', filterCenterId);
      if (filterTrainerId) params.set('trainer_membership_id', filterTrainerId);
      apiFetch<ScheduleSession[]>(`/me/schedule?${params}`)
        .then((sessions) =>
          successCb([
            ...sessions.map((s) => ({
              id: String(s.id),
              title: s.class_type_name,
              start: s.starts_at,
              end: s.ends_at,
              backgroundColor: STATE_COLORS[s.availability_state],
              borderColor:     STATE_COLORS[s.availability_state],
              extendedProps: s,
            })),
            ...holidayBackgroundEvents(holidays, info.start, info.end),
          ]),
        )
        .catch(failureCb);
    },
    [filterAtId, filterCenterId, filterTrainerId, apiFetch, holidays],
  );

  function refetch() {
    calendarRef.current?.getApi().refetchEvents();
  }

  function openFilterPanel() {
    setPendingCenterId(filterCenterId);
    setPendingTrainerId(filterTrainerId);
    setShowFilterPanel(true);
  }

  function applyFilters() {
    setFilterCenterId(pendingCenterId);
    setFilterTrainerId(pendingTrainerId);
    setShowFilterPanel(false);
  }

  function clearFilters() {
    setPendingCenterId('');
    setPendingTrainerId('');
    setFilterCenterId('');
    setFilterTrainerId('');
    setShowFilterPanel(false);
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
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #e5e7eb', display: 'flex', gap: 8, flexShrink: 0 }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => (showFilterPanel ? setShowFilterPanel(false) : openFilterPanel())}
            style={{
              padding: '4px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
              border: '1px solid #d1d5db',
              background: filtersActive ? 'var(--gd-sidebar-selected-bg, #18181b)' : 'transparent',
              color:      filtersActive ? '#fff' : 'inherit',
              whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5,
            }}
          >
            {t('filter_button')}
            {filtersActive && (
              <span style={{
                display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                background: '#f97316',
              }} />
            )}
          </button>

          {showFilterPanel && (
            <div
              style={{
                position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 70,
                width: 240, background: 'var(--gd-card-bg, #fff)', borderRadius: 10,
                border: '1px solid #e5e7eb', boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
                padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
              }}
            >
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>
                  {t('filter_center_label')}
                </div>
                <select
                  value={pendingCenterId}
                  onChange={(e) => setPendingCenterId(e.target.value)}
                  style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
                >
                  <option value="">{t('filter_all_centers')}</option>
                  {centers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 }}>
                  {t('filter_trainer_label')}
                </div>
                <select
                  value={pendingTrainerId}
                  onChange={(e) => setPendingTrainerId(e.target.value)}
                  style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
                >
                  <option value="">{t('filter_all_trainers')}</option>
                  {trainers.map((tr) => (
                    <option key={tr.id} value={tr.id}>{tr.name}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  onClick={applyFilters}
                  style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: 'none', background: 'var(--gd-sidebar-selected-bg, #18181b)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                >
                  {t('filter_apply')}
                </button>
                <button
                  onClick={clearFilters}
                  style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db', background: 'transparent', fontSize: 12, cursor: 'pointer' }}
                >
                  {t('filter_clear')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
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
          businessHours={businessHours}
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
                <div style={{ opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {t('occupancy_count', { booked: s.booked_count, capacity: s.effective_capacity })}
                </div>
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
              {selected.center_name ? ` · ${selected.center_name}` : ''}
              {selected.space_name ? ` · ${selected.space_name}` : ''}
            </p>

            {/* #503 stage 7: the three-badge breakdown agreed on the issue thread —
                lifecycle status, occupancy status (+ aggregate count), and waitlist
                (aggregate count only; never member identities), each independent. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 12px' }}>
              <span style={badgeStyle('#e5e7eb', '#374151')}>{t(`status_${selected.status}`)}</span>
              <span style={badgeStyle(OCCUPANCY_BADGE_COLORS[selected.occupancy_status], '#fff')}>
                {t(`occupancy_${selected.occupancy_status}`)} · {t('occupancy_count', { booked: selected.booked_count, capacity: selected.effective_capacity })}
              </span>
              {selected.waitlist_status !== 'disabled' && (
                <span style={badgeStyle('#a855f7', '#fff')}>
                  {t(`waitlist_${selected.waitlist_status}`)}
                  {selected.waitlist_count > 0 ? ` · ${t('waitlist_count', { count: selected.waitlist_count })}` : ''}
                </span>
              )}
            </div>

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

const OCCUPANCY_BADGE_COLORS: Record<OccupancyStatus, string> = {
  available:       '#3b82f6',
  few_spots_left:  '#f59e0b',
  full:            '#ef4444',
  unavailable:     '#9ca3af',
};

function badgeStyle(bg: string, color: string): React.CSSProperties {
  return {
    display: 'inline-block', padding: '3px 9px', borderRadius: 12,
    fontSize: 11.5, fontWeight: 600, background: bg, color,
  };
}

function actionBtn(bg: string): React.CSSProperties {
  return {
    padding: '12px', borderRadius: 8, border: 'none', background: bg,
    color: '#fff', fontWeight: 600, fontSize: 15, cursor: 'pointer', width: '100%',
  };
}
