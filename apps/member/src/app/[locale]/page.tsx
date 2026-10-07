'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import { MembersSectionCard, useSectionImageUrl } from '@/components/MembersSectionCard';
import {
  destructiveButtonStyle,
  memberTheme,
  noticeStyle,
  primaryButtonStyle,
  rowDividerStyle,
  secondaryButtonStyle,
  sectionCardStyle,
  statusPillStyle,
  statusTone,
} from '@/lib/memberChrome';
import { BOOKED_ON_KEY, CANCELLATION_NOTICE_TITLE_KEY, cancellationNoticeKey, type CancellationBlock } from '@/lib/bookingCancellation';
import type { MemberBackgroundSlot } from '@/lib/membersBackground';
import { goalDetail, goalLabel, type NutritionGoalItem } from '@/lib/nutritionFood';

interface UpcomingBooking {
  id: number;
  class_session_id: number;
  class_type_name: string;
  starts_at: string;
  ends_at: string;
  room_name: string | null;
  center_name: string | null;
  my_booking_status: 'booked' | 'waitlisted' | 'attended' | 'no_show' | null;
  my_booking_id: number | null;
  /** #1162 — when the booking was created, and whether it can still be cancelled. */
  booked_on: string | null;
  can_cancel: boolean;
  cancellation_block: CancellationBlock;
  professional_service: boolean;
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
type NutritionGoal = NutritionGoalItem;
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
  const hasProductsImage = useSectionImageUrl('membership') !== null;
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading, member, isSuperadmin } = useApp();
  const { isImpersonating } = useImpersonation();
  const { flags: featureFlags } = useFeatureFlags();
  // Superadmins bypass member_web.* flags only in their native capacity — while
  // impersonating a member, visibility must reflect that member's own flags (#439).
  const featureEnabled = (key: string) => (isSuperadmin && !isImpersonating) || isFeatureEnabled(featureFlags, key);

  const [nextBooking, setNextBooking] = useState<UpcomingBooking | null | undefined>(undefined);
  const [sameDayMore, setSameDayMore] = useState(0);
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
        apiFetch<{ membership: Membership | null }>('/me/membership').catch(() => ({ membership: null })),
        apiFetch<{ items: NotificationItem[] }>('/me/notifications?limit=5').catch(() => ({ items: [] })),
        apiFetch<{ plan: NutritionPlan | null }>('/me/nutrition-plan').catch(() => ({ plan: null })),
      ]);

      const booked = sessions.filter(
        (s) => s.my_booking_status === 'booked' || s.my_booking_status === 'waitlisted',
      );
      setNextBooking(booked[0] ?? null);
      setSameDayMore(
        booked[0]
          ? booked.filter((b) => dateOnly(b.starts_at) === dateOnly(booked[0].starts_at)).length - 1
          : 0,
      );
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
    if (!isLinked) {
      setLoading(false);
      return;
    }
    load();
  }, [appLoading, isLinked]);

  function goToBookings() { router.push(`/${locale}/schedule`); }

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

  // Superadmin with no impersonation target has no member identity — /me/profile
  // is 403 and widgets would spin forever. Prompt them to impersonate instead (#415).
  if (isSuperadmin && !isImpersonating) {
    return (
      <main style={styles.container}>
        <h1 style={styles.greeting}>{t('impersonation.home_prompt_title')}</h1>
        <section style={styles.section}>
          <div style={styles.card}>
            <p style={styles.hint}>{t('impersonation.home_prompt')}</p>
          </div>
        </section>
      </main>
    );
  }

  if (isImpersonating && !isLinked) {
    return (
      <main style={styles.container}>
        <section style={styles.section}>
          <div style={styles.card}>
            <p style={styles.hint}>{t('impersonation.error_profile')}</p>
          </div>
        </section>
      </main>
    );
  }

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
      {featureEnabled('member_web.my_bookings') && (
        <section style={styles.section}>
          <h2 style={styles.h2}>{t('home.next_booking')}</h2>
          {/* #1158 — the card paints the Theme's My Next Bookings artwork
              (`next_bookings`) behind the contents it always had; with no image
              it is the same Section Card surface as every other card. Its body
              is a structure of its own, so `nextBookingCard` keeps the block
              layout and left alignment it spells (the #1116 products-card
              rule), and the content stays above the image untouched. */}
          {loading ? (
            <MembersSectionCard slot="next_bookings" style={styles.nextBookingCard}><p style={styles.hint}>{t('home.loading')}</p></MembersSectionCard>
          ) : nextBooking ? (
            <MembersSectionCard slot="next_bookings" style={{ ...styles.nextBookingCard, cursor: 'pointer' }} onClick={goToBookings}>
              <div style={styles.bookingRow}>
                <div>
                  <p style={styles.bookingName}>{nextBooking.class_type_name}</p>
                  {nextBooking.room_name && (
                    <p style={styles.bookingSub}>{nextBooking.room_name}</p>
                  )}
                  {nextBooking.center_name && (
                    <p style={styles.bookingSub}>{nextBooking.center_name}</p>
                  )}
                  <p style={styles.bookingSub}>
                    {dateOnly(nextBooking.starts_at)} · {timeOnly(nextBooking.starts_at)}–{timeOnly(nextBooking.ends_at)}
                  </p>
                  {nextBooking.booked_on && (
                    <p style={styles.bookingSub}>{t(BOOKED_ON_KEY, { date: `${dateOnly(nextBooking.booked_on)} · ${timeOnly(nextBooking.booked_on)}` })}</p>
                  )}
                </div>
                {nextBooking.my_booking_status === 'waitlisted' && (
                  <span style={styles.pillWait}>{t('home.waitlisted')}</span>
                )}
              </div>
              {nextBooking.my_booking_id && nextBooking.my_booking_status === 'booked' && nextBooking.can_cancel && (
                <button
                  style={styles.btnCancel}
                  disabled={cancelPending}
                  onClick={(e) => { e.stopPropagation(); cancelBooking(nextBooking.my_booking_id!); }}
                >
                  {cancelPending ? '…' : t('member_schedule.cancel_booking')}
                </button>
              )}
              {nextBooking.my_booking_id && nextBooking.my_booking_status === 'booked' && cancellationNoticeKey(nextBooking) && (
                /* #1162 §5 — the explanation stands where the action was. */
                <div style={styles.cancelNotice} onClick={(e) => e.stopPropagation()}>
                  <strong>{t(CANCELLATION_NOTICE_TITLE_KEY)}</strong> {t(cancellationNoticeKey(nextBooking)!)}
                </div>
              )}
              {sameDayMore > 0 && (
                <p style={styles.bookingSub}>{t('home.more_bookings_that_day', { count: sameDayMore })}</p>
              )}
            </MembersSectionCard>
          ) : (
            <MembersSectionCard slot="next_bookings" style={{ ...styles.nextBookingCard, cursor: 'pointer' }} onClick={goToBookings}>
              <p style={styles.hint}>{t('home.no_upcoming_booking')}</p>
              <button
                style={styles.btnSecondary}
                onClick={(e) => { e.stopPropagation(); router.push(`/${locale}/calendar`); }}
              >
                {t('home.browse_calendar')}
              </button>
            </MembersSectionCard>
          )}
        </section>
      )}

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
                  {/* The same slug translation and the same "1 l · daily"
                      wording as My Nutrition (#932): the stored value is
                      `weight_loss`, not a label. */}
                  {nutritionPlan!.goals
                    .map((g) => [goalLabel(t, g.item_name), goalDetail(t, g)].filter(Boolean).join(' · '))
                    .join('   ')}
                </p>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Main navigation — each tile carries its own theme background image
          (#728) — plus My Products & Services, which since #1116 is a cell of
          this same grid rather than a full-width row underneath it: that is
          what puts it beside My Goals in the last row, at the tiles' own width,
          gap and (grid `stretch`) height, with no second grid and no layout of
          its own. */}
      <section style={styles.tileGrid}>
        <NavTile slot="calendar" icon="📅" label={t('nav.calendar')} onClick={() => router.push(`/${locale}/calendar`)} />
        {featureEnabled('member_web.my_training_plan') && (
          <NavTile slot="training" icon="🏋️" label={t('nav.training')} onClick={() => router.push(`/${locale}/training`)} />
        )}
        {featureEnabled('member_web.my_bookings') && (
          <NavTile slot="bookings" icon="🎟️" label={t('nav.bookings')} onClick={() => router.push(`/${locale}/schedule`)} />
        )}
        {featureEnabled('member_web.my_nutrition') && (
          <NavTile slot="nutrition" icon="🥗" label={t('nav.nutrition')} onClick={() => router.push(`/${locale}/nutrition`)} />
        )}
        {featureEnabled('member_web.my_goals') && (
          <NavTile slot="personal_goals" icon="🎯" label={t('nav.goals')} onClick={() => router.push(`/${locale}/goals`)} />
        )}

        {/* My Products & Services (#1116) — the same card, the same slot
            artwork, the same contents and the same destination as the
            My Membership card it replaces. Its body is a column so the status
            badge sits at the bottom right of a half-width cell instead of
            being squeezed beside a wrapping title. */}
        {featureEnabled('member_web.my_membership') && (
          <MembersSectionCard slot="membership" style={styles.productsTile} onClick={() => router.push(`/${locale}/membership`)} role="button" tabIndex={0}>
            {!hasProductsImage && <span style={styles.tileIcon}>🛍️</span>}
            <p style={styles.productsTitle}>{t('home.products_services')}</p>
            <p style={styles.bookingSub}>
              {loading
                ? t('home.loading')
                : membership
                  ? (membership.plan_name ?? '—') + (membership.ends_at ? ` · ${t('home.expires_on', { date: dateOnly(membership.ends_at) })}` : ` · ${t('membership.ongoing')}`)
                  : t('home.no_membership')}
            </p>
            {!loading && membership && (
              <div style={styles.productsStatusRow}>
                <StatusPill status={membership.status} label={t(`membership.status.${membership.status}`)} />
              </div>
            )}
          </MembersSectionCard>
        )}
      </section>
    </main>
  );
}

function alertTypeLabel(t: ReturnType<typeof useTranslations>, type: string): string {
  try { return t(`notifications.type_${type}` as any); } catch { return type; }
}

/**
 * A navigation tile. It spells none of the five Section Cards text properties
 * (#1152): the label's colour, size and font and the content's two positions
 * are `MembersSectionCard`'s, read from the Theme, so `styles.tile` carries
 * only the box and `styles.tileLabel` only the weight.
 */
function NavTile({ slot, icon, label, onClick }: { slot: MemberBackgroundSlot; icon: string; label: string; onClick: () => void }) {
  // #982: the uploaded artwork is the tile's whole visual. When the theme
  // configures this slot the default emoji is not rendered at all — not over
  // the picture, not under it, and with no placeholder in its place — and the
  // tile keeps the height the icon used to give it so the artwork has the same
  // box to fill. A slot the theme does not configure renders exactly as it did
  // before: the default icon, and no `minHeight` of its own.
  const hasImage = useSectionImageUrl(slot) !== null;
  return (
    <MembersSectionCard
      slot={slot}
      as="button"
      style={hasImage ? { ...styles.tile, ...styles.tileWithImage } : styles.tile}
      onClick={onClick}
    >
      {!hasImage && <span style={styles.tileIcon}>{icon}</span>}
      <span style={styles.tileLabel}>{label}</span>
    </MembersSectionCard>
  );
}

function StatusPill({ status, label }: { status: string; label: string }) {
  // #983 — the tone and its two colours are `lib/memberChrome.ts`'s: the same
  // four Assigned Plan statuses are shown here, on My Membership and on My
  // Bookings, and three copies of the map were three places to theme.
  return <span style={{ ...statusPillStyle(statusTone(status)), padding: '4px 12px' }}>{label}</span>;
}

const styles: Record<string, React.CSSProperties> = {
  center:          { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: memberTheme.pageBackground, padding: 24 },
  landingCard:     { ...sectionCardStyle, borderRadius: 16, padding: '48px 40px', maxWidth: 400, width: '100%', textAlign: 'center', boxShadow: '0 2px 16px rgba(0,0,0,0.08)' },
  landingTitle:    { margin: '0 0 8px', fontSize: 32, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  landingSubtitle: { margin: '0 0 32px', color: memberTheme.textMuted, fontSize: 16 },
  container:       { padding: 16, maxWidth: 720, margin: '0 auto' },
  greeting:        { margin: '8px 0 20px', fontSize: 24, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  section:         { marginBottom: 20 },
  h2:              { margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font, textTransform: 'uppercase', letterSpacing: '0.05em' },
  card:            { ...sectionCardStyle, padding: '16px 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', cursor: 'default' },
  nextBookingCard: { ...sectionCardStyle, padding: '16px 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', cursor: 'default', display: 'block', textAlign: 'left' },
  bookingRow:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  bookingName:     { margin: 0, fontSize: 17, fontWeight: 700, color: memberTheme.text },
  bookingSub:      { margin: '4px 0 0', fontSize: 13, color: memberTheme.textMuted },
  planName:        { margin: 0, fontSize: 17, fontWeight: 700, color: memberTheme.text },
  messageBanner:   { ...noticeStyle('success'), marginBottom: 16 },
  cancelNotice:    { ...noticeStyle('warning'), fontSize: 13, marginTop: 8 },
  pillWait:        statusPillStyle('warning'),
  hint:            { color: memberTheme.textMuted, fontSize: 14, margin: '4px 0 12px' },
  btnPrimary:      { ...primaryButtonStyle, display: 'block', width: '100%', padding: '14px 0', fontSize: 16, fontWeight: 600, marginBottom: 16 },
  btnSecondary:    { ...secondaryButtonStyle, marginTop: 8, padding: '10px 18px', fontSize: 14, fontWeight: 600 },
  btnCancel:       { ...destructiveButtonStyle, width: '100%', padding: '10px 0', fontSize: 15, fontWeight: 600, marginTop: 4 },
  alertCard:       { ...noticeStyle('warning'), borderRadius: 12, padding: '14px 18px', cursor: 'pointer' },
  alertTitle:      { margin: 0, fontSize: 15, fontWeight: 700, color: 'inherit' },
  alertLink:       { margin: '6px 0 0', fontSize: 13, fontWeight: 600, color: 'inherit' },
  mealRow:         { ...rowDividerStyle, padding: '6px 0' },
  mealName:        { margin: 0, fontSize: 14, fontWeight: 700, color: memberTheme.text },
  goalsRow:        { padding: '10px 0 0' },
  tileGrid:        { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 },
  tile:            { ...sectionCardStyle, gap: 8, borderRadius: 14, padding: '24px 8px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', cursor: 'pointer' },
  productsTile:    { ...sectionCardStyle, display: 'flex', flexDirection: 'column', gap: 2, borderRadius: 14, padding: '18px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', cursor: 'pointer', textAlign: 'left' },
  productsTitle:   { margin: 0, fontSize: 17, fontWeight: 700 },
  productsStatusRow: { marginTop: 'auto', paddingTop: 10, display: 'flex', justifyContent: 'flex-end' },
  tileIcon:        { fontSize: 32 },
  tileWithImage:   { minHeight: 110 },
  tileLabel:       { fontWeight: 600 },
};
