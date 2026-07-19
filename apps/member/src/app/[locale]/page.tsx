'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRouter, usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

interface UpcomingBooking {
  id: number;
  class_session_id: number;
  class_type_name: string;
  starts_at: string;
  ends_at: string;
  room_name: string | null;
  my_booking_status: 'booked' | 'waitlisted' | 'attended' | 'no_show' | null;
  my_booking_id: number | null;
}

interface Membership {
  plan_name: string | null;
  ends_at: string | null;
  status: 'active' | 'paused' | 'cancelled' | 'expired';
}

interface ClassPackage {
  sessions_remaining: number;
  status: 'active' | 'consumed' | 'expired' | 'cancelled';
}

function timeOnly(iso: string) { return iso.slice(11, 16); }
function dateOnly(iso: string) { return iso.slice(0, 10); }

export default function HomePage() {
  const { isSignedIn, isLoaded } = useAuth();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading } = useApp();

  const [nextBooking, setNextBooking] = useState<UpcomingBooking | null | undefined>(undefined);
  const [membership, setMembership] = useState<Membership | null | undefined>(undefined);
  const [creditTotal, setCreditTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelPending, setCancelPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const to = new Date();
      to.setDate(to.getDate() + 7);

      const [sessions, mship, pkgs] = await Promise.all([
        apiFetch<UpcomingBooking[]>(`/me/schedule?to=${to.toISOString()}`),
        apiFetch<{ membership: Membership | null }>('/me/membership'),
        apiFetch<ClassPackage[]>('/me/class-packages').catch(() => [] as ClassPackage[]),
      ]);

      const booked = sessions.filter(
        (s) => s.my_booking_status === 'booked' || s.my_booking_status === 'waitlisted',
      );
      setNextBooking(booked[0] ?? null);
      setMembership(mship.membership);

      const activeCredits = pkgs
        .filter((p) => p.status === 'active')
        .reduce((sum, p) => sum + p.sessions_remaining, 0);
      setCreditTotal(activeCredits > 0 ? activeCredits : null);
    } catch {
      // non-fatal: dashboard degrades gracefully
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) return;
    load();
  }, [appLoading, isLinked]);

  async function cancelBooking(bookingId: number) {
    setCancelPending(true);
    setMessage(null);
    try {
      await apiFetch(`/me/bookings/${bookingId}`, { method: 'DELETE' });
      setMessage(t('member_schedule.cancelled'));
      setNextBooking(null);
    } catch (err: any) {
      setMessage(err.message ?? t('common.error'));
    } finally {
      setCancelPending(false);
    }
  }

  // Not signed in — show landing
  if (!isLoaded || (!isSignedIn && !appLoading)) {
    return (
      <main style={styles.center}>
        <div style={styles.landingCard}>
          <h1 style={styles.landingTitle}>{t('home.title')}</h1>
          <p style={styles.landingSubtitle}>{t('home.subtitle')}</p>
          {!isLoaded ? (
            <p style={styles.hint}>…</p>
          ) : (
            <>
              <button style={styles.btnPrimary} onClick={() => router.push(`/${locale}/sign-in`)}>
                {t('home.sign_in')}
              </button>
              <p style={styles.hint}>{t('home.hint')}</p>
            </>
          )}
        </div>
      </main>
    );
  }

  // Signed in but not yet linked — let AppContext redirect
  if (appLoading) {
    return <main style={styles.container}><p style={styles.hint}>…</p></main>;
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('home.dashboard_title')}</h1>

      {message && <div style={styles.messageBanner}>{message}</div>}

      {/* Next booking */}
      <section style={styles.section}>
        <h2 style={styles.h2}>{t('home.next_booking')}</h2>
        {loading ? (
          <div style={styles.card}><p style={styles.hint}>{t('home.loading')}</p></div>
        ) : nextBooking ? (
          <div style={styles.card}>
            <div style={styles.bookingRow}>
              <div>
                <p style={styles.bookingName}>{nextBooking.class_type_name}</p>
                {nextBooking.room_name && (
                  <p style={styles.bookingSub}>{nextBooking.room_name}</p>
                )}
                <p style={styles.bookingSub}>
                  {dateOnly(nextBooking.starts_at)} · {timeOnly(nextBooking.starts_at)}–{timeOnly(nextBooking.ends_at)}
                </p>
              </div>
              {nextBooking.my_booking_status === 'waitlisted' && (
                <span style={styles.pillWait}>{t('home.waitlisted')}</span>
              )}
            </div>
            {nextBooking.my_booking_id && nextBooking.my_booking_status === 'booked' && (
              <button
                style={styles.btnCancel}
                disabled={cancelPending}
                onClick={() => cancelBooking(nextBooking.my_booking_id!)}
              >
                {cancelPending ? '…' : t('member_schedule.cancel_booking')}
              </button>
            )}
          </div>
        ) : (
          <div style={styles.card}>
            <p style={styles.hint}>{t('home.no_upcoming_booking')}</p>
            <button style={styles.btnSecondary} onClick={() => router.push(`/${locale}/schedule`)}>
              {t('home.browse_schedule')}
            </button>
          </div>
        )}
      </section>

      {/* Membership snapshot */}
      <section style={styles.section}>
        <h2 style={styles.h2}>{t('home.membership_status')}</h2>
        {loading ? (
          <div style={styles.card}><p style={styles.hint}>{t('home.loading')}</p></div>
        ) : membership ? (
          <div style={styles.card}>
            <div style={styles.membershipRow}>
              <p style={styles.planName}>{membership.plan_name ?? '—'}</p>
              <StatusPill status={membership.status} label={t(`membership.status.${membership.status}`)} />
            </div>
            <p style={styles.bookingSub}>
              {membership.ends_at
                ? t('home.expires_on', { date: dateOnly(membership.ends_at) })
                : t('membership.ongoing')}
            </p>
          </div>
        ) : (
          <div style={styles.card}>
            <p style={styles.hint}>{t('home.no_membership')}</p>
          </div>
        )}
      </section>

      {/* Credits (hidden when 0) */}
      {!loading && creditTotal !== null && (
        <section style={styles.section}>
          <h2 style={styles.h2}>{t('home.class_credits')}</h2>
          <div style={styles.card}>
            <p style={styles.creditCount}>{creditTotal}</p>
            <p style={styles.bookingSub}>{t('home.credits_remaining')}</p>
          </div>
        </section>
      )}
    </main>
  );
}

function StatusPill({ status, label }: { status: string; label: string }) {
  const COLORS: Record<string, { bg: string; fg: string }> = {
    active:    { bg: '#e6f6ec', fg: '#1e7e40' },
    paused:    { bg: '#fff4e0', fg: '#b26a00' },
    cancelled: { bg: '#fdeaea', fg: '#c0392b' },
    expired:   { bg: '#f3eafd', fg: '#7d3cbd' },
  };
  const c = COLORS[status] ?? { bg: '#f0f0f0', fg: '#666' };
  return (
    <span style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: '4px 12px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  center:          { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5', padding: 24 },
  landingCard:     { background: '#fff', borderRadius: 16, padding: '48px 40px', maxWidth: 400, width: '100%', textAlign: 'center', boxShadow: '0 2px 16px rgba(0,0,0,0.08)' },
  landingTitle:    { margin: '0 0 8px', fontSize: 32, fontWeight: 700, color: '#18181b' },
  landingSubtitle: { margin: '0 0 32px', color: '#71717a', fontSize: 16 },
  container:       { padding: 16, maxWidth: 720, margin: '0 auto' },
  title:           { margin: '8px 0 20px', fontSize: 24, fontWeight: 700, color: '#18181b' },
  section:         { marginBottom: 24 },
  h2:              { margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.05em' },
  card:            { background: '#fff', borderRadius: 12, padding: '16px 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  bookingRow:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  bookingName:     { margin: 0, fontSize: 17, fontWeight: 700, color: '#18181b' },
  bookingSub:      { margin: '4px 0 0', fontSize: 13, color: '#71717a' },
  membershipRow:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 6 },
  planName:        { margin: 0, fontSize: 17, fontWeight: 700, color: '#18181b' },
  creditCount:     { margin: 0, fontSize: 36, fontWeight: 800, color: '#18181b', fontVariantNumeric: 'tabular-nums' },
  messageBanner:   { background: '#e6f6ec', color: '#1e7e40', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 14 },
  pillWait:        { background: '#fff4e0', color: '#b26a00', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
  hint:            { color: '#71717a', fontSize: 14, margin: '4px 0 12px' },
  btnPrimary:      { display: 'block', width: '100%', padding: '14px 0', background: '#18181b', color: '#fff', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 600, cursor: 'pointer', marginBottom: 16 },
  btnSecondary:    { marginTop: 8, padding: '10px 18px', background: 'transparent', color: '#18181b', border: '1px solid #e4e4e7', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  btnCancel:       { width: '100%', padding: '10px 0', background: 'transparent', color: '#c0392b', border: '1px solid #c0392b', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', marginTop: 4 },
};
