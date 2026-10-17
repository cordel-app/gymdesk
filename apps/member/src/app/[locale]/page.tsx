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
  memberTheme,
  noticeStyle,
  primaryButtonStyle,
  rowDividerStyle,
  secondaryButtonStyle,
  sectionCardStyle,
  statusPillStyle,
  statusTone,
} from '@/lib/memberChrome';
import type { MemberBackgroundSlot } from '@/lib/membersBackground';
import { formatGymTime } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { goalDetail, goalLabel, mealTitle, type NutritionGoalItem } from '@/lib/nutritionFood';

interface UpcomingBooking {
  id: number;
  class_session_id: number;
  class_type_name: string;
  starts_at: string;
  ends_at: string;
  /** The same read the Calendar uses: the Activity's description and the event's own image, else the Activity's. */
  class_type_description?: string | null;
  class_type_image_url?: string | null;
  space_name: string | null;
  trainer_name: string | null;
  center_name: string | null;
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
  payload?: { starts_at?: string; center_name?: string; space_name?: string; trainer_name?: string } | null;
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
  const gymFormat = useGymFormatSettings();
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
  const [activeProducts, setActiveProducts] = useState(0);
  const [nutritionPlan, setNutritionPlan] = useState<NutritionPlan | null>(null);
  const [alert, setAlert] = useState<NotificationItem | null>(null);
  const [loading, setLoading] = useState(true);
  // The server renders this page with Clerk not loaded (`isLoaded` false), but by
  // the time the client hydrates Clerk's script may already have loaded, so the
  // first client render took the signed-in branch while the HTML on screen was
  // the landing card: React reported #418/#423/#425, threw the server tree away
  // and rendered the whole root again, on every load of the Home. `hydrated` is
  // false on the server and on the client's first render, so both choose the same
  // branch, and the real state is read one commit later.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  const authKnown = hydrated && isLoaded;

  async function load() {
    setLoading(true);
    try {
      const to = new Date();
      to.setDate(to.getDate() + 7);

      const [sessions, mship, notifs, nutrition] = await Promise.all([
        apiFetch<UpcomingBooking[]>(`/me/schedule?to=${to.toISOString()}`),
        apiFetch<{ membership: Membership | null; active_products_count?: number }>('/me/membership').catch(() => ({ membership: null, active_products_count: 0 })),
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
      setActiveProducts(mship.active_products_count ?? 0);
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

  // Clerk's state is not known yet (always the case on the server and on the
  // first client render): a bare placeholder, never the signed-out landing. The
  // landing carries the brand and a sign-in prompt, and a member who is signed in
  // used to see it flash on every load before their own screen arrived.
  if (!authKnown) {
    return <main style={styles.container}><p style={styles.hint}>…</p></main>;
  }

  // Not signed in — show landing
  if (!isSignedIn && !appLoading) {
    return (
      <main style={styles.center}>
        <div style={styles.landingCard}>
          <h1 style={styles.landingTitle}>{t('home.title')}</h1>
          <p style={styles.landingSubtitle}>{t('home.subtitle')}</p>
          <button style={styles.btnPrimary} onClick={() => router.push(`/${locale}/sign-in`)}>
            {t('home.sign_in')}
          </button>
          <p style={styles.hint}>{t('home.hint')}</p>
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


      {/* Alerts */}
      {!loading && alert && (
        <section style={styles.section}>
          <div style={styles.alertCard} onClick={() => router.push(`/${locale}/notifications`)}>
            <p style={styles.alertTitle}>⚠️ {alertTypeLabel(t, alert.type)}</p>
            {alert.type === 'booking_reminder_2h' && (() => {
              const p = alert.payload;
              const parts = [
                p?.starts_at ? formatGymTime(p.starts_at, gymFormat) : null,
                p?.center_name,
                p?.space_name,
                p?.trainer_name ? t('home.reminder_trainer', { name: p.trainer_name }) : null,
              ].filter(Boolean);
              return parts.length > 0 ? <p style={styles.alertDetail}>{parts.join(' · ')}</p> : null;
            })()}
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
              {/* #1764 — one structure with or without an image: the image is an
                  optional square column that stretches to the information's
                  height; with none there is no empty column. */}
              <div style={styles.bookingLayout}>
                {nextBooking.class_type_image_url && (
                  <div style={styles.bookingImageBox}>
                    <img src={nextBooking.class_type_image_url} alt="" style={styles.bookingImage} />
                  </div>
                )}
                <div style={styles.bookingInfo}>
                  <div style={styles.bookingRow}>
                    <p style={styles.bookingName}>{nextBooking.class_type_name}</p>
                    {nextBooking.my_booking_status === 'waitlisted' && (
                      <span style={styles.pillWait}>{t('home.waitlisted')}</span>
                    )}
                  </div>
                  {nextBooking.class_type_description?.trim() && (
                    <p style={styles.bookingSub}>{nextBooking.class_type_description.trim()}</p>
                  )}
                  <p style={styles.bookingSub}>
                    {dateOnly(nextBooking.starts_at)} · {timeOnly(nextBooking.starts_at)}–{timeOnly(nextBooking.ends_at)}
                  </p>
                  {([
                    ['📍', nextBooking.center_name, t('home.booking_center')],
                    ['🧑‍🏫', nextBooking.trainer_name, t('home.booking_trainer')],
                    ['🚪', nextBooking.space_name, t('home.booking_space')],
                  ] as const).map(([icon, value, label]) => value?.trim() ? (
                    <p key={label} style={styles.bookingDetail} title={label}>
                      <span aria-hidden="true">{icon}</span>
                      <span className="sr-only" style={styles.srOnly}>{label}: </span>
                      <span>{value.trim()}</span>
                    </p>
                  ) : null)}
                  {sameDayMore > 0 && (
                    <p style={styles.bookingSub}>{t('home.more_bookings_that_day', { count: sameDayMore })}</p>
                  )}
                </div>
              </div>
            </MembersSectionCard>
          ) : (
            <MembersSectionCard slot="next_bookings" style={{ ...styles.nextBookingCard, cursor: 'pointer' }} onClick={goToBookings}>
              <p style={styles.hint}>{t('home.no_upcoming_booking')}</p>
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
                <p style={styles.mealName}>{mealTitle(meal.display_name, meal.meal_type, meal.meal_type ? t(`nutrition.meal_type.${meal.meal_type}` as any) : null).title}</p>
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
            <span style={styles.tileLabel}>{t('home.products_services')}</span>
            {/* #1218 — the plan and the product count sit left-aligned at the
                bottom of the card, under the title the tiles' own way. */}
            <div style={styles.productsInfo}>
              <p style={styles.bookingSub}>
                {loading
                  ? t('home.loading')
                  : membership
                    ? `${membership.plan_name ?? '—'} (${t(`membership.status.${membership.status}`)})`
                    : t('home.no_plan')}
              </p>
              {!loading && (
                <p style={styles.bookingSub}>{t('home.additional_products', { count: activeProducts })}</p>
              )}
            </div>
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

const styles: Record<string, React.CSSProperties> = {
  center:          { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: memberTheme.pageBackground, padding: 24 },
  landingCard:     { ...sectionCardStyle, borderRadius: 16, padding: '48px 40px', maxWidth: 400, width: '100%', textAlign: 'center', boxShadow: '0 2px 16px rgba(0,0,0,0.08)' },
  landingTitle:    { margin: '0 0 8px', fontSize: 32, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  landingSubtitle: { margin: '0 0 32px', color: memberTheme.textMuted, fontSize: 16 },
  container:       { padding: 16, maxWidth: 720, margin: '0 auto' },
  greeting:        { margin: '8px 0 20px', fontSize: 24, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  section:         { marginBottom: 20 },
  h2:              { margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font, textTransform: 'uppercase', letterSpacing: '0.05em' },
  card:            { ...sectionCardStyle, padding: '16px 18px', cursor: 'default' },
  nextBookingCard: { ...sectionCardStyle, padding: '16px 18px', cursor: 'default', display: 'block', textAlign: 'left' },
  bookingLayout:   { display: 'flex', alignItems: 'stretch', gap: 14 },
  bookingImageBox: { flex: '0 0 auto', alignSelf: 'stretch', aspectRatio: '1 / 1', position: 'relative', borderRadius: 8, overflow: 'hidden' },
  bookingImage:    { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  bookingInfo:     { flex: '1 1 0', minWidth: 0 },
  bookingRow:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  bookingDetail:   { margin: '4px 0 0', fontSize: 13, color: memberTheme.textMuted, display: 'flex', gap: 6, alignItems: 'center' },
  srOnly:          { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
  bookingName:     { margin: 0, fontSize: 17, fontWeight: 700, color: memberTheme.text },
  bookingSub:      { margin: '4px 0 0', fontSize: 13, color: memberTheme.textMuted },
  planName:        { margin: 0, fontSize: 17, fontWeight: 700, color: memberTheme.text },
  pillWait:        statusPillStyle('warning'),
  hint:            { color: memberTheme.textMuted, fontSize: 14, margin: '4px 0 12px' },
  btnPrimary:      { ...primaryButtonStyle, display: 'block', width: '100%', padding: '14px 0', fontSize: 16, fontWeight: 600, marginBottom: 16 },
  btnSecondary:    { ...secondaryButtonStyle, marginTop: 8, padding: '10px 18px', fontSize: 14, fontWeight: 600 },
  alertCard:       { ...noticeStyle('warning'), borderRadius: 12, padding: '14px 18px', cursor: 'pointer' },
  alertTitle:      { margin: 0, fontSize: 15, fontWeight: 700, color: 'inherit' },
  alertDetail:     { margin: '4px 0 0', fontSize: 13, color: 'inherit' },
  alertLink:       { margin: '6px 0 0', fontSize: 13, fontWeight: 600, color: 'inherit' },
  mealRow:         { ...rowDividerStyle, padding: '6px 0' },
  mealName:        { margin: 0, fontSize: 14, fontWeight: 700, color: memberTheme.text },
  goalsRow:        { padding: '10px 0 0' },
  tileGrid:        { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 },
  tile:            { ...sectionCardStyle, gap: 8, padding: '24px 8px', cursor: 'pointer' },
  productsTile:    { ...sectionCardStyle, gap: 8, padding: '24px 8px', cursor: 'pointer' },
  productsInfo:    { marginTop: 'auto', paddingTop: 10, textAlign: 'left', alignSelf: 'stretch' },
  tileIcon:        { fontSize: 32 },
  tileWithImage:   { minHeight: 110 },
  tileLabel:       { fontWeight: 600 },
};
