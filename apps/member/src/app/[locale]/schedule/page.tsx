'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import {
  destructiveButtonStyle,
  memberTheme,
  noticeStyle,
  primaryButtonStyle,
  sectionCardStyle,
  statusPillStyle,
} from '@/lib/memberChrome';

interface Session {
  id: number;
  activity_type_id: number;
  class_type_name: string;
  class_type_description: string | null;
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

function dayKey(iso: string) { return iso.slice(0, 10); }
function timeOnly(iso: string) { return iso.slice(11, 16); }

export default function MemberSchedulePage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading, isSuperadmin } = useApp();
  const { isImpersonating } = useImpersonation();
  const { flags: featureFlags } = useFeatureFlags();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingSession, setPendingSession] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expandedSession, setExpandedSession] = useState<number | null>(null);

  const [pastBookings, setPastBookings] = useState<PastBooking[]>([]);
  const [pastLoading, setPastLoading] = useState(true);
  const [pastError, setPastError] = useState<string | null>(null);
  const [expandedPast, setExpandedPast] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    const to = new Date();
    to.setDate(to.getDate() + 14);
    const toStr = to.toISOString();
    try {
      const sessionData = await apiFetch<Session[]>(`/me/schedule?to=${toStr}`);
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

  async function bookSession(sessionId: number) {
    setPendingSession(sessionId); setMessage(null);
    try {
      const result: any = await apiFetch('/me/bookings', {
        method: 'POST', body: JSON.stringify({ class_session_id: sessionId }),
      });
      setMessage(result.status === 'waitlisted'
        ? t('member_schedule.waitlisted_at', { pos: result.waitlist_position ?? '?' })
        : t('member_schedule.booked'));
      load();
    } catch (err: any) {
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
    return Array.from(g.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [sessions]);

  function pastStatusLabel(item: PastBooking): string {
    if (item.booking_status === 'cancelled') return t('member_schedule.past_status_cancelled');
    if (item.attendance_status === 'present') return t('member_schedule.past_status_present');
    if (item.attendance_status === 'absent') return t('member_schedule.past_status_absent');
    return t('member_schedule.past_status_pending');
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('member_schedule.title')}</h1>

      {message && <div style={styles.message}>{message}</div>}

      <h2 style={styles.sectionHead}>{t('member_schedule.upcoming_section')}</h2>

      {loading ? (
        <p style={styles.hint}>{t('member_schedule.loading')}</p>
      ) : loadError ? (
        <p style={styles.errorHint}>{loadError}</p>
      ) : grouped.length === 0 ? (
        <p style={styles.hint}>{t('member_schedule.empty')}</p>
      ) : (
        grouped.map(([day, list]) => (
          <section key={day} style={{ marginTop: 20 }}>
            <h3 style={styles.dayHead}>{day}</h3>
            {list.map((s) => {
              const isBusy = pendingSession === s.id;
              const myStatus = s.my_booking_status;
              const spots = s.spots_left;
              const isExpanded = expandedSession === s.id;
              return (
                <div
                  key={`s-${s.id}`}
                  style={styles.card}
                  onClick={() => setExpandedSession(isExpanded ? null : s.id)}
                  role="button"
                  tabIndex={0}
                >
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
                  <div style={styles.name}>{s.class_type_name}</div>
                  {s.space_name && <div style={styles.sub}>{s.space_name}</div>}
                  {s.center_name && <div style={styles.sub}>{s.center_name}</div>}
                  {s.trainer_name && <div style={styles.sub}>{s.trainer_name}</div>}
                  {isExpanded && (
                    <div style={styles.details}>
                      {s.class_type_description && <div style={styles.sub}>{s.class_type_description}</div>}
                      <div style={styles.sub}>
                        {t('member_schedule.capacity_detail', { booked: s.booked_count, capacity: s.effective_capacity })}
                      </div>
                    </div>
                  )}
                  <div style={{ marginTop: 10, display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                    {s.access_locked ? null : myStatus && s.my_booking_id && s.can_cancel ? (
                      <button style={styles.btnCancel} disabled={isBusy} onClick={() => cancelSession(s.my_booking_id!, s.id)}>
                        {isBusy ? '…' : t('member_schedule.cancel_booking')}
                      </button>
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
              );
            })}
          </section>
        ))
      )}

      <h2 style={{ ...styles.sectionHead, marginTop: 28 }}>{t('member_schedule.past_section')}</h2>

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
                  <span style={styles.time}>{dayKey(item.starts_at)} · {timeOnly(item.starts_at)}</span>
                  <span style={item.booking_status === 'cancelled' ? styles.pillFull : styles.pillBooked}>
                    {pastStatusLabel(item)}
                  </span>
                </div>
                <div style={styles.name}>{item.title}</div>
                {isExpanded && (
                  <div style={styles.details}>
                    <div style={styles.sub}>{timeOnly(item.starts_at)} – {timeOnly(item.ends_at)}</div>
                    {item.cancelled_at && (
                      <div style={styles.sub}>{t('member_schedule.cancelled_at_detail', { date: dayKey(item.cancelled_at) })}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, maxWidth: 720, margin: '0 auto' },
  title: { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  message: { ...noticeStyle('success'), marginBottom: 16 },
  sectionHead: { margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font },
  dayHead: { margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: memberTheme.title3, fontFamily: memberTheme.title3Font, textTransform: 'uppercase', letterSpacing: '0.05em' },
  card: { ...sectionCardStyle, borderRadius: 10, padding: 14, marginBottom: 10, cursor: 'pointer' },
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
  btnCancel: { ...destructiveButtonStyle, flex: 1, padding: '10px 0', fontSize: 15, fontWeight: 600 },
  btnWait: { ...primaryButtonStyle, flex: 1, padding: '10px 0', background: memberTheme.statusWarning, fontSize: 15, fontWeight: 600 },
  hint: { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '20px 0' },
  errorHint: { color: memberTheme.statusError, fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
