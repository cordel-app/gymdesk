'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

interface Session {
  id: number;
  class_type_id: number;
  class_type_name: string;
  class_type_description: string | null;
  starts_at: string;
  ends_at: string;
  room_name: string | null;
  effective_capacity: number;
  booked_count: number;
  spots_left: number;
  my_booking_status: 'booked' | 'waitlisted' | 'attended' | 'no_show' | null;
  my_waitlist_position: number | null;
  my_booking_id: number | null;
  access_locked: boolean;
}

function dayKey(iso: string) { return iso.slice(0, 10); }
function timeOnly(iso: string) { return iso.slice(11, 16); }

export default function MemberSchedulePage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading } = useApp();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const to = new Date();
      to.setDate(to.getDate() + 14);
      const data = await apiFetch<Session[]>(`/me/schedule?to=${to.toISOString()}`);
      setSessions(data);
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    load();
  }, [appLoading, isLinked, locale]);

  async function book(sessionId: number) {
    setPending(sessionId); setMessage(null);
    try {
      const result: any = await apiFetch('/me/bookings', {
        method: 'POST', body: JSON.stringify({ class_session_id: sessionId }),
      });
      if (result.status === 'waitlisted') {
        setMessage(t('member_schedule.waitlisted_at', { pos: result.waitlist_position ?? '?' }));
      } else {
        setMessage(t('member_schedule.booked'));
      }
      load();
    } catch (err: any) {
      // Translate the plan_required backend code; otherwise show the raw message
      setMessage(err.message?.includes('plan_required') ? t('member_schedule.plan_required') : (err.message ?? t('common.error')));
    } finally { setPending(null); }
  }

  async function cancel(bookingId: number, sessionId: number) {
    setPending(sessionId); setMessage(null);
    try {
      await apiFetch(`/me/bookings/${bookingId}`, { method: 'DELETE' });
      setMessage(t('member_schedule.cancelled'));
      load();
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
    finally { setPending(null); }
  }

  const grouped = useMemo(() => {
    const g = new Map<string, Session[]>();
    for (const s of sessions) {
      const k = dayKey(s.starts_at);
      const arr = g.get(k) ?? [];
      arr.push(s);
      g.set(k, arr);
    }
    return Array.from(g.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [sessions]);

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('member_schedule.title')}</h1>

      {message && <div style={styles.message}>{message}</div>}

      {loading ? (
        <p style={styles.hint}>{t('member_schedule.loading')}</p>
      ) : grouped.length === 0 ? (
        <p style={styles.hint}>{t('member_schedule.empty')}</p>
      ) : (
        grouped.map(([day, list]) => (
          <section key={day} style={{ marginTop: 20 }}>
            <h2 style={styles.dayHead}>{day}</h2>
            {list.map((s) => {
              const isBusy = pending === s.id;
              const myStatus = s.my_booking_status;
              const spots = s.spots_left;
              return (
                <div key={s.id} style={styles.card}>
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
                  {s.room_name && <div style={styles.sub}>{s.room_name}</div>}
                  <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                    {s.access_locked ? null : myStatus && s.my_booking_id ? (
                      <button style={styles.btnCancel} disabled={isBusy} onClick={() => cancel(s.my_booking_id!, s.id)}>
                        {isBusy ? '…' : t('member_schedule.cancel_booking')}
                      </button>
                    ) : spots > 0 ? (
                      <button style={styles.btnBook} disabled={isBusy} onClick={() => book(s.id)}>
                        {isBusy ? '…' : t('member_schedule.book')}
                      </button>
                    ) : (
                      <button style={styles.btnWait} disabled={isBusy} onClick={() => book(s.id)}>
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
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, maxWidth: 720, margin: '0 auto' },
  title: { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: '#18181b' },
  message: { background: '#e6f6ec', color: '#1e7e40', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 14 },
  dayHead: { margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.05em' },
  card: { background: '#fff', borderRadius: 10, padding: 14, marginBottom: 10 },
  time: { fontVariantNumeric: 'tabular-nums', fontSize: 14, fontWeight: 600, color: '#18181b' },
  name: { fontSize: 16, fontWeight: 600, color: '#18181b' },
  sub: { fontSize: 13, color: '#71717a', marginTop: 2 },
  spots: { fontSize: 12, color: '#71717a' },
  pillBooked: { background: '#e6f6ec', color: '#1e7e40', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600 },
  pillWait: { background: '#fff4e0', color: '#b26a00', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600 },
  pillFull: { background: '#fdeaea', color: '#c0392b', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600 },
  pillLocked: { background: '#f3eafd', color: '#7d3cbd', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600 },
  btnBook: { flex: 1, padding: '10px 0', background: '#18181b', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  btnCancel: { flex: 1, padding: '10px 0', background: 'transparent', color: '#c0392b', border: '1px solid #c0392b', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  btnWait: { flex: 1, padding: '10px 0', background: '#b26a00', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  hint: { color: '#71717a', fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
