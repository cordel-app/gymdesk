'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import {
  secondaryButtonStyle,
  memberTheme,
  noticeStyle,
  primaryButtonStyle,
  sectionCardStyle,
  statusPillStyle,
} from '@/lib/memberChrome';
import { BOOKED_ON_KEY, CANCELLATION_NOTICE_TITLE_KEY, cancellationNoticeKey, type CancellationBlock } from '@/lib/bookingCancellation';
import { formatGymDate, formatGymTime } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { requiredServiceIds, productsPathForServices } from '@/lib/serviceRequired';
import { BOOKINGS_TABS, UPCOMING_WINDOW_DAYS, bookingsTabAfter, type BookingsTab } from '@/lib/bookingsTabs';
import { CancelBookingConfirmDialog } from '@/components/CancelBookingConfirmDialog';
import { ActivityMetaIcon } from '@/components/ActivityMetaIcon';
import { ImagePreviewButton } from '@/components/ImagePreview';

interface Session {
  id: number;
  activity_type_id: number;
  class_type_name: string;
  class_type_description: string | null;
  /** #1880 — the event's own image, else the Activity Type's (as the Calendar sheet shows). */
  class_type_image_url?: string | null;
  starts_at: string;
  ends_at: string;
  space_name: string | null;
  center_name: string | null;
  trainer_name: string | null;
  effective_capacity: number;
  booked_count: number;
  spots_left: number;
  my_booking_status: 'booked' | 'waitlisted' | null;
  my_waitlist_position: number | null;
  my_booking_id: number | null;
  access_locked: boolean;
  can_cancel: boolean;
  /** #1162 — when the member's own booking was created, and why it cannot be cancelled when it cannot. */
  booked_on: string | null;
  cancellation_block: CancellationBlock;
  professional_service: boolean;
}

interface PastBooking {
  booking_id: number;
  entity_id: number;
  title: string;
  starts_at: string;
  ends_at: string;
  booking_status: 'booked' | 'waitlisted' | 'cancelled';
  attendance_status: 'pending' | 'present' | 'absent';
  cancelled_at: string | null;
}

interface FilterOption { id: number; name: string }

export default function MemberSchedulePage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading, isSuperadmin, centers } = useApp();
  const { isImpersonating } = useImpersonation();
  const { flags: featureFlags } = useFeatureFlags();
  // The API sends UTC instants. Slicing the ISO string showed UTC wall-clock time
  // under a raw `2026-10-13`; the gym's own zone and date format (#1246) are what
  // the Calendar and Alerts already use, so this screen says the same hour.
  const gymFormat = useGymFormatSettings();
  const dayKey = (iso: string) => formatGymDate(iso, { ...gymFormat, date_format: 'YYYY-MM-DD' });
  const dayLabel = (iso: string) => formatGymDate(iso, gymFormat);
  const timeOnly = (iso: string) => formatGymTime(iso, gymFormat);
  const [confirmCancel, setConfirmCancel] = useState<{ bookingId: number; sessionId: number } | null>(null);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingSession, setPendingSession] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [unlockServiceIds, setUnlockServiceIds] = useState<number[]>([]);
  const [expandedSession, setExpandedSession] = useState<number | null>(null);

  const [pastBookings, setPastBookings] = useState<PastBooking[]>([]);
  const [pastLoading, setPastLoading] = useState(true);
  const [pastError, setPastError] = useState<string | null>(null);
  const [expandedPast, setExpandedPast] = useState<number | null>(null);
  // #1893: Upcoming and Past are two tabs of one page; Upcoming is the default.
  const [tab, setTab] = useState<BookingsTab>('upcoming');

  // #1880: the Calendar's own three filters, answered by the same `/me/schedule`
  // query parameters (`center_id`, `trainer_membership_id`, `activity_type_id`),
  // so filtering decides nothing on the client.
  const [activityTypes, setActivityTypes] = useState<FilterOption[]>([]);
  const [trainers, setTrainers] = useState<FilterOption[]>([]);
  const [filterAtId, setFilterAtId] = useState('');
  const [filterCenterId, setFilterCenterId] = useState('');
  const [filterTrainerId, setFilterTrainerId] = useState('');

  async function load() {
    setLoading(true);
    setLoadError(null);
    // #1983: the Upcoming tab is the next 7 days, as an absolute instant window.
    const toStr = new Date(Date.now() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    try {
      const params = new URLSearchParams({ to: toStr });
      if (filterAtId) params.set('activity_type_id', filterAtId);
      if (filterCenterId) params.set('center_id', filterCenterId);
      if (filterTrainerId) params.set('trainer_membership_id', filterTrainerId);
      const sessionData = await apiFetch<Session[]>(`/me/schedule?${params.toString()}`);
      setSessions(sessionData);
    } catch (err: any) { setLoadError(err.message ?? t('common.error')); }
    finally { setLoading(false); }
  }

  async function loadPast() {
    setPastLoading(true);
    setPastError(null);
    try {
      const result = await apiFetch<{ items: PastBooking[] }>('/me/activity-history?limit=20');
      setPastBookings(result.items);
    } catch (err: any) { setPastError(err.message ?? t('common.error')); }
    finally { setPastLoading(false); }
  }

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    if (!(isSuperadmin && !isImpersonating) && !isFeatureEnabled(featureFlags, 'member_web.my_bookings')) { router.replace(`/${locale}`); return; }
    load();
    loadPast();
  }, [appLoading, isLinked, locale, isSuperadmin, isImpersonating, featureFlags]);

  useEffect(() => {
    if (appLoading || !isLinked) return;
    apiFetch<FilterOption[]>('/me/activity-types').then(setActivityTypes).catch(() => {});
    apiFetch<FilterOption[]>('/me/trainers').then(setTrainers).catch(() => {});
  }, [appLoading, isLinked]);

  // Re-read the list when a filter changes (not on first mount: the effect above did).
  const [filtersTouched, setFiltersTouched] = useState(false);
  useEffect(() => {
    if (!filtersTouched) return;
    load();
  }, [filterAtId, filterCenterId, filterTrainerId]);

  async function bookSession(sessionId: number) {
    setPendingSession(sessionId); setMessage(null); setUnlockServiceIds([]);
    try {
      const result: any = await apiFetch('/me/bookings', {
        method: 'POST', body: JSON.stringify({ class_session_id: sessionId }),
      });
      setMessage(result.status === 'waitlisted'
        ? t('member_schedule.waitlisted_at', { pos: result.waitlist_position ?? '?' })
        : t('member_schedule.booked'));
      load();
    } catch (err: any) {
      setUnlockServiceIds(requiredServiceIds(err));
      setMessage(err.message?.includes('plan_required') ? t('member_schedule.plan_required') : (err.message ?? t('common.error')));
    } finally { setPendingSession(null); }
  }

  async function cancelSession(bookingId: number, sessionId: number) {
    setPendingSession(sessionId); setMessage(null);
    try {
      await apiFetch(`/me/bookings/${bookingId}`, { method: 'DELETE' });
      setMessage(t('member_schedule.cancelled'));
      load();
      loadPast();
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
    finally { setPendingSession(null); }
  }

  const grouped = useMemo(() => {
    const g = new Map<string, Session[]>();
    for (const item of sessions) {
      const k = dayKey(item.starts_at);
      const arr = g.get(k) ?? [];
      arr.push(item);
      g.set(k, arr);
    }
    for (const [, arr] of g) arr.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    return Array.from(g.entries()).sort((a, b) => a[1][0].starts_at.localeCompare(b[1][0].starts_at));
  }, [sessions, gymFormat]);

  function pastStatusLabel(item: PastBooking): string {
    if (item.booking_status === 'cancelled') return t('member_schedule.past_status_cancelled');
    if (item.attendance_status === 'present') return t('member_schedule.past_status_present');
    if (item.attendance_status === 'absent') return t('member_schedule.past_status_absent');
    return t('member_schedule.past_status_pending');
  }

  return (
    <main style={styles.container}>

      {message && <div style={styles.message}>{message}</div>}
      {unlockServiceIds.length > 0 && (
        <button
          onClick={() => router.push(`/${locale}${productsPathForServices(unlockServiceIds)}`)}
          style={{ ...primaryButtonStyle, padding: '10px 16px', marginBottom: 16 }}
        >
          {t('member_schedule.buy_sessions_cta')}
        </button>
      )}

      <div role="tablist" aria-label={t('member_schedule.title')} style={styles.tabs}>
        {BOOKINGS_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`bookings-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`bookings-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const next = bookingsTabAfter(tab, e.key === 'ArrowRight' ? 1 : -1);
              setTab(next);
              document.getElementById(`bookings-tab-${next}`)?.focus();
            }}
            style={tab === id ? { ...styles.tab, ...styles.tabActive } : styles.tab}
          >
            {t(id === 'upcoming' ? 'member_schedule.upcoming_section' : 'member_schedule.past_section')}
          </button>
        ))}
      </div>

      {tab === 'upcoming' && (
      <div role="tabpanel" id="bookings-panel-upcoming" aria-labelledby="bookings-tab-upcoming">
      <div style={styles.filters}>
        {([
          ['filter_activity', 'filter_all_activities', filterAtId, setFilterAtId, activityTypes],
          ['filter_center', 'filter_all_centers', filterCenterId, setFilterCenterId, centers],
          ['filter_trainer', 'filter_all_trainers', filterTrainerId, setFilterTrainerId, trainers],
        ] as const).map(([label, all, value, setValue, options]) => (
          <select
            key={label}
            aria-label={t(`member_schedule.${label}`)}
            value={value}
            onChange={(e) => { setFiltersTouched(true); setValue(e.target.value); }}
            style={styles.filterSelect}
          >
            <option value="">{t(`member_schedule.${all}`)}</option>
            {options.map((o) => (
              <option key={o.id} value={String(o.id)}>{o.name}</option>
            ))}
          </select>
        ))}
      </div>
      {loading ? (
        <p style={styles.hint}>{t('member_schedule.loading')}</p>
      ) : loadError ? (
        <p style={styles.errorHint}>{loadError}</p>
      ) : grouped.length === 0 ? (
        <p style={styles.hint}>{t('member_schedule.empty')}</p>
      ) : (
        grouped.map(([day, list]) => (
          <section key={day} style={{ marginTop: 20 }}>
            <h3 style={styles.dayHead}>{dayLabel(list[0].starts_at)}</h3>
            {list.map((s) => {
              const isBusy = pendingSession === s.id;
              const myStatus = s.my_booking_status;
              const spots = s.spots_left;
              const isExpanded = expandedSession === s.id;
              return (
                <div
                  key={`s-${s.id}`}
                  style={styles.sessionCard}
                  onClick={() => setExpandedSession(isExpanded ? null : s.id)}
                  role="button"
                  tabIndex={0}
                >
                  {/* #1880 §4/§5 — the image fills the card's height on the left and
                      opens the enlarged preview with the description; with no image
                      the content takes the whole width. */}
                  {s.class_type_image_url && s.class_type_image_url.trim() && (
                    <div style={styles.imageCol}>
                      <ImagePreviewButton
                        src={s.class_type_image_url}
                        alt={t('member_schedule.image_alt', { name: s.class_type_name })}
                        title={s.class_type_name}
                        description={s.class_type_description?.trim() || null}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={s.class_type_image_url} alt="" style={styles.cardImage} />
                      </ImagePreviewButton>
                    </div>
                  )}
                  <div style={styles.cardBody}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={styles.time}>{timeOnly(s.starts_at)} – {timeOnly(s.ends_at)}</span>
                    {s.access_locked ? (
                      <span style={styles.pillLocked}>🔒 {t('member_schedule.plan_only')}</span>
                    ) : myStatus === 'booked' ? (
                      <span style={styles.pillBooked}>{t('member_schedule.status_booked')}</span>
                    ) : myStatus === 'waitlisted' ? (
                      <span style={styles.pillWait}>{t('member_schedule.waitlist_pos', { pos: s.my_waitlist_position ?? '?' })}</span>
                    ) : spots > 0 ? (
                      <span style={styles.spots}>{t('member_schedule.spots_left', { n: spots })}</span>
                    ) : (
                      <span style={styles.pillFull}>{t('member_schedule.full')}</span>
                    )}
                  </div>
                  <div style={{ ...styles.name, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{s.class_type_name}</span>
                    {s.professional_service && (
                      <span
                        title={t('member_schedule.professional_service_required')}
                        aria-label={t('member_schedule.professional_service_required')}
                        role="img"
                        style={{ color: memberTheme.textMuted, display: 'inline-flex' }}
                      >
                        <ActivityMetaIcon name="service" size={15} />
                      </span>
                    )}
                  </div>
                  {([
                    ['center', s.center_name],
                    ['space', s.space_name],
                    ['trainer', s.trainer_name],
                  ] as const).map(([icon, value]) => (value && value.trim() ? (
                    <div key={icon} style={{ ...styles.sub, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ActivityMetaIcon name={icon} />
                      <span>{value.trim()}</span>
                    </div>
                  ) : null))}
                  {isExpanded && (
                    <div style={styles.details}>
                      {s.class_type_description && <div style={styles.sub}>{s.class_type_description}</div>}
                      <div style={styles.sub}>
                        {t('member_schedule.capacity_detail', { booked: s.booked_count, capacity: s.effective_capacity })}
                      </div>
                      {s.my_booking_id && s.booked_on && (
                        <div style={styles.sub}>{t(BOOKED_ON_KEY, { date: `${dayLabel(s.booked_on)} · ${timeOnly(s.booked_on)}` })}</div>
                      )}
                    </div>
                  )}
                  <div style={{ marginTop: 10, display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                    {s.access_locked ? null : myStatus && s.my_booking_id && s.can_cancel ? (
                      <button style={styles.btnCancel} disabled={isBusy} onClick={() => setConfirmCancel({ bookingId: s.my_booking_id!, sessionId: s.id })}>
                        {isBusy ? '…' : t('member_schedule.cancel_booking')}
                      </button>
                    ) : myStatus && s.my_booking_id && cancellationNoticeKey(s) ? (
                      /* #1162 §5 — the explanation stands where the action was,
                         rather than the action silently disappearing. */
                      <div style={styles.cancelNotice}>
                        <strong>{t(CANCELLATION_NOTICE_TITLE_KEY)}</strong> {t(cancellationNoticeKey(s)!)}
                      </div>
                    ) : myStatus ? null : spots > 0 ? (
                      <button style={styles.btnBook} disabled={isBusy} onClick={() => bookSession(s.id)}>
                        {isBusy ? '…' : t('member_schedule.book')}
                      </button>
                    ) : (
                      <button style={styles.btnWait} disabled={isBusy} onClick={() => bookSession(s.id)}>
                        {isBusy ? '…' : t('member_schedule.join_waitlist')}
                      </button>
                    )}
                  </div>
                  </div>
                </div>
              );
            })}
          </section>
        ))
      )}

      </div>
      )}

      {tab === 'past' && (
      <div role="tabpanel" id="bookings-panel-past" aria-labelledby="bookings-tab-past">
      {pastLoading ? (
        <p style={styles.hint}>{t('member_schedule.loading')}</p>
      ) : pastError ? (
        <p style={styles.errorHint}>{pastError}</p>
      ) : pastBookings.length === 0 ? (
        <p style={styles.hint}>{t('member_schedule.past_empty')}</p>
      ) : (
        <section style={{ marginTop: 12 }}>
          {pastBookings.map((item) => {
            const isExpanded = expandedPast === item.booking_id;
            return (
              <div
                key={`p-${item.booking_id}`}
                style={styles.card}
                onClick={() => setExpandedPast(isExpanded ? null : item.booking_id)}
                role="button"
                tabIndex={0}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={styles.time}>{dayLabel(item.starts_at)} · {timeOnly(item.starts_at)}</span>
                  <span style={item.booking_status === 'cancelled' ? styles.pillFull : styles.pillBooked}>
                    {pastStatusLabel(item)}
                  </span>
                </div>
                <div style={styles.name}>{item.title}</div>
                {isExpanded && (
                  <div style={styles.details}>
                    <div style={styles.sub}>{timeOnly(item.starts_at)} – {timeOnly(item.ends_at)}</div>
                    {item.cancelled_at && (
                      <div style={styles.sub}>{t('member_schedule.cancelled_at_detail', { date: dayLabel(item.cancelled_at) })}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
      </div>
      )}
      {confirmCancel && (
        <CancelBookingConfirmDialog
          busy={pendingSession === confirmCancel.sessionId}
          onClose={() => setConfirmCancel(null)}
          onConfirm={async () => {
            const target = confirmCancel;
            await cancelSession(target.bookingId, target.sessionId);
            setConfirmCancel(null);
          }}
        />
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, maxWidth: 720, margin: '0 auto' },
  message: { ...noticeStyle('success'), marginBottom: 16 },
  cancelNotice: { ...noticeStyle('warning'), fontSize: 13, flex: 1 },
  tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${memberTheme.separator}`, marginBottom: 12 },
  tab: { flex: 1, minHeight: 44, padding: '8px 12px', background: 'transparent', border: 'none', borderBottom: '3px solid transparent', color: memberTheme.textMuted, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  tabActive: { color: memberTheme.text, borderBottomColor: memberTheme.primaryButton },
  sectionHead: { margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font },
  dayHead: { margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: memberTheme.title3, fontFamily: memberTheme.title3Font, textTransform: 'uppercase', letterSpacing: '0.05em' },
  card: { ...sectionCardStyle, padding: 14, marginBottom: 10, cursor: 'pointer' },
  filters: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  filterSelect: { flex: '1 1 140px', minWidth: 0, minHeight: 40, padding: '6px 10px', borderRadius: 8, border: `1px solid ${memberTheme.separator}`, background: memberTheme.inputBackground, color: memberTheme.text, fontSize: 14 },
  sessionCard: { ...sectionCardStyle, padding: 0, marginBottom: 10, cursor: 'pointer', display: 'flex', overflow: 'hidden' },
  imageCol: { flex: '0 0 112px', alignSelf: 'stretch', position: 'relative' },
  cardImage: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  cardBody: { flex: 1, minWidth: 0, padding: 14 },
  details: { marginTop: 8, paddingTop: 8, borderTop: `1px solid ${memberTheme.separator}` },
  time: { fontVariantNumeric: 'tabular-nums', fontSize: 14, fontWeight: 600, color: memberTheme.text },
  name: { fontSize: 16, fontWeight: 600, color: memberTheme.text },
  sub: { fontSize: 13, color: memberTheme.textMuted, marginTop: 2 },
  spots: { fontSize: 12, color: memberTheme.textMuted },
  pillBooked: statusPillStyle('success'),
  pillWait: statusPillStyle('warning'),
  pillFull: statusPillStyle('error'),
  pillLocked: statusPillStyle('info'),
  btnBook: { ...primaryButtonStyle, flex: 1, padding: '10px 0', fontSize: 15, fontWeight: 600 },
  btnCancel: { ...secondaryButtonStyle, flex: 1, padding: '10px 0', fontSize: 15, fontWeight: 600 },
  btnWait: { ...primaryButtonStyle, flex: 1, padding: '10px 0', background: memberTheme.statusWarning, fontSize: 15, fontWeight: 600 },
  hint: { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '20px 0' },
  errorHint: { color: memberTheme.statusError, fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
