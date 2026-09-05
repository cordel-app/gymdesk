'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
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

interface NotificationItem {
  id: number;
  type: string;
  read_at: string | null;
}

interface MealItem { id: number; item_name: string; component_type: string; quantity: number | null; unit: string | null }
interface Meal { id: number; meal_type: string | null; display_name: string; items: MealItem[] }
interface NutritionDay { id: number; weekday: number; meals: Meal[] }
interface NutritionGoal { id: number; item_name: string; quantity: number; unit: string; frequency: string }
interface NutritionPlan { id: number; name: string; days: NutritionDay[]; goals: NutritionGoal[] }

const ALL_DAYS_WEEKDAY = 7;

function timeOnly(iso: string) { return iso.slice(11, 16); }
function dateOnly(iso: string) { return iso.slice(0, 10); }
function todayWeekday() { return (new Date().getDay() + 6) % 7; } // 0=Mon..6=Sun

function greetingKey(): 'greeting_morning' | 'greeting_afternoon' | 'greeting_evening' {
  const hour = new Date().getHours();
  if (hour < 12) return 'greeting_morning';
  if (hour < 18) return 'greeting_afternoon';
  return 'greeting_evening';
}

export default function HomePage() {
  const { isSignedIn, isLoaded } = useAuth();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading, member } = useApp();

  const [nextBooking, setNextBooking] = useState<UpcomingBooking | null | undefined>(undefined);
  const [membership, setMembership] = useState<Membership | null | undefined>(undefined);
  const [nutritionPlan, setNutritionPlan] = useState<NutritionPlan | null>(null);
  const [alert, setAlert] = useState<NotificationItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelPending, setCancelPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const to = new Date();
      to.setDate(to.getDate() + 7);

      const [sessions, mship, notifs, nutrition] = await Promise.all([
        apiFetch<UpcomingBooking[]>(`/me/schedule?to=${to.toISOString()}`),
        apiFetch<{ membership: Membership | null }>('/me/membership'),
        apiFetch<{ items: NotificationItem[] }>('/me/notifications?limit=5').catch(() => ({ items: [] })),
        apiFetch<{ plan: NutritionPlan | null }>('/me/nutrition-plan').catch(() => ({ plan: null })),
      ]);

      const booked = sessions.filter(
        (s) => s.my_booking_status === 'booked' || s.my_booking_status === 'waitlisted',
      );
      setNextBooking(booked[0] ?? null);
      setMembership(mship.membership);
      setAlert(notifs.items.find((n) => n.read_at === null) ?? null);
      setNutritionPlan(nutrition.plan);
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

  const firstName = member?.name?.split(' ')[0] ?? '';
  const todayMeals = nutritionPlan?.days
    .filter((d) => d.weekday === todayWeekday() || d.weekday === ALL_DAYS_WEEKDAY)
    .flatMap((d) => d.meals) ?? [];

  return (
    <main style={styles.container}>
      <h1 style={styles.greeting}>{t(`home.${greetingKey()}`, { name: firstName })}</h1>

      {message && <div style={styles.messageBanner}>{message}</div>}

      {/* Alerts */}
      {!loading && alert && (
        <section style={styles.section}>
          <div style={styles.alertCard} onClick={() => router.push(`/${locale}/notifications`)}>
            <p style={styles.alertTitle}>⚠️ {alertTypeLabel(t, alert.type)}</p>
            <p style={styles.alertLink}>{t('home.alerts_view_all')} →</p>
          </div>
        </section>
      )}

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
            <button style={styles.btnSecondary} onClick={() => router.push(`/${locale}/calendar`)}>
              {t('home.browse_calendar')}
            </button>
          </div>
        )}
      </section>

      {/* Today's Nutrition Plan — omitted entirely when there's nothing to show */}
      {!loading && todayMeals.length > 0 && (
        <section style={styles.section}>
          <h2 style={styles.h2}>{t('home.nutrition_today')}</h2>
          <div style={styles.card}>
            {todayMeals.map((meal) => (
              <div key={meal.id} style={styles.mealRow}>
                <p style={styles.mealName}>{meal.display_name}</p>
                <p style={styles.bookingSub}>
                  {meal.items.map((i) => i.item_name).join(' + ')}
                </p>
              </div>
            ))}
            {nutritionPlan!.goals.length > 0 && (
              <div style={styles.goalsRow}>
                <p style={styles.mealName}>{t('home.goals')}</p>
                <p style={styles.bookingSub}>
                  {nutritionPlan!.goals.map((g) => `${g.item_name} · ${g.quantity}${g.unit}`).join('   ')}
                </p>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Main navigation */}
      <section style={styles.tileGrid}>
        <NavTile icon="📅" label={t('nav.calendar')} onClick={() => router.push(`/${locale}/calendar`)} />
        <NavTile icon="🏋️" label={t('nav.training')} onClick={() => router.push(`/${locale}/training`)} />
        <NavTile icon="🎟️" label={t('nav.bookings')} onClick={() => router.push(`/${locale}/schedule`)} />
        <NavTile icon="🥗" label={t('nav.nutrition')} onClick={() => router.push(`/${locale}/nutrition`)} />
      </section>

      {/* My Membership */}
      <section style={styles.section}>
        <div style={styles.card} onClick={() => router.push(`/${locale}/membership`)} role="button" tabIndex={0}>
          <div style={styles.membershipRow}>
            <p style={styles.planName}>{t('membership.title')}</p>
            {!loading && membership && (
              <StatusPill status={membership.status} label={t(`membership.status.${membership.status}`)} />
            )}
          </div>
          <p style={styles.bookingSub}>
            {loading
              ? t('home.loading')
              : membership
                ? (membership.plan_name ?? '—') + (membership.ends_at ? ` · ${t('home.expires_on', { date: dateOnly(membership.ends_at) })}` : ` · ${t('membership.ongoing')}`)
                : t('home.no_membership')}
          </p>
        </div>
      </section>
    </main>
  );
}

function alertTypeLabel(t: ReturnType<typeof useTranslations>, type: string): string {
  try { return t(`notifications.type_${type}` as any); } catch { return type; }
}

function NavTile({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button style={styles.tile} onClick={onClick}>
      <span style={styles.tileIcon}>{icon}</span>
      <span style={styles.tileLabel}>{label}</span>
    </button>
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
  greeting:        { margin: '8px 0 20px', fontSize: 24, fontWeight: 700, color: '#18181b' },
  section:         { marginBottom: 20 },
  h2:              { margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.05em' },
  card:            { background: '#fff', borderRadius: 12, padding: '16px 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', cursor: 'default' },
  bookingRow:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  bookingName:     { margin: 0, fontSize: 17, fontWeight: 700, color: '#18181b' },
  bookingSub:      { margin: '4px 0 0', fontSize: 13, color: '#71717a' },
  membershipRow:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 6 },
  planName:        { margin: 0, fontSize: 17, fontWeight: 700, color: '#18181b' },
  messageBanner:   { background: '#e6f6ec', color: '#1e7e40', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 14 },
  pillWait:        { background: '#fff4e0', color: '#b26a00', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
  hint:            { color: '#71717a', fontSize: 14, margin: '4px 0 12px' },
  btnPrimary:      { display: 'block', width: '100%', padding: '14px 0', background: '#18181b', color: '#fff', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 600, cursor: 'pointer', marginBottom: 16 },
  btnSecondary:    { marginTop: 8, padding: '10px 18px', background: 'transparent', color: '#18181b', border: '1px solid #e4e4e7', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  btnCancel:       { width: '100%', padding: '10px 0', background: 'transparent', color: '#c0392b', border: '1px solid #c0392b', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', marginTop: 4 },
  alertCard:       { background: '#fff4e0', border: '1px solid #f9c734', borderRadius: 12, padding: '14px 18px', cursor: 'pointer' },
  alertTitle:      { margin: 0, fontSize: 15, fontWeight: 700, color: '#92600a' },
  alertLink:       { margin: '6px 0 0', fontSize: 13, fontWeight: 600, color: '#92600a' },
  mealRow:         { padding: '6px 0', borderBottom: '1px solid #f0f0f0' },
  mealName:        { margin: 0, fontSize: 14, fontWeight: 700, color: '#18181b' },
  goalsRow:        { padding: '10px 0 0' },
  tileGrid:        { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 },
  tile:            { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#fff', borderRadius: 14, padding: '24px 8px', border: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', cursor: 'pointer' },
  tileIcon:        { fontSize: 32 },
  tileLabel:       { fontSize: 13, fontWeight: 600, color: '#18181b', textAlign: 'center' },
};
