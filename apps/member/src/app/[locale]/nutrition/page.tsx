'use client';

import { completionActions } from '@/lib/nutritionCompletion';
import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import { NutritionFoodCarousel } from '@/components/NutritionFoodCarousel';
import { NutritionItemRow, nutritionItemGridStyle } from '@/components/NutritionItemRow';
import { TrainingSummaryCards } from '@/components/TrainingSummaryCards';
import { TrainingStatusLegend, DAY_STATUS_COLOR } from '@/components/TrainingStatusLegend';
import { NUTRITION_DAY_STATUSES, type NutritionDayStatus } from '@/lib/trainingDayStatus';
import { ProgressCounts, deviceToday, mondayIndex, canShowNextWeek, shiftWeekWithin, swipeWeekDelta, weekDates, weekStart } from '@/lib/trainingWeek';
import { memberTheme, primaryButtonStyle, sectionCardStyle, statusPillStyle, statusTone } from '@/lib/memberChrome';
import {
  NutritionFoodItem,
  NutritionGoalItem,
  NutritionRestrictionItem,
  goalDetail,
  goalLabel,
  mealTitle,
} from '@/lib/nutritionFood';

// Weekday / date names are locale-driven, not a gym format setting (allowlisted in member-gym-format-allowlist).
function dayText(locale: string, ymd: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`));
}

interface Meal { id: number; meal_type: string | null; display_name: string; notes: string | null; items: NutritionFoodItem[] }
interface NutritionDay { id: number; weekday: number; meals: Meal[] }
interface NutritionPlan {
  id: number;
  name: string;
  description: string | null;
  days: NutritionDay[];
  goals: NutritionGoalItem[];
  restrictions: NutritionRestrictionItem[];
}

const ALL_DAYS_WEEKDAY = 7;

// #1580: the same shape /me/training-progress answers, plus the week's day statuses.
interface NutritionProgress {
  day: ProgressCounts; week: ProgressCounts; month: ProgressCounts;
  week_days: { date: string; status: NutritionDayStatus }[];
  today?: string;
}
const EMPTY_COUNTS: ProgressCounts = { completed: 0, total: 0, percent: 0 };
const EMPTY_PROGRESS: NutritionProgress = { day: EMPTY_COUNTS, week: EMPTY_COUNTS, month: EMPTY_COUNTS, week_days: [] };

export default function NutritionPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading, isSuperadmin } = useApp();
  const { isImpersonating } = useImpersonation();
  const { flags: featureFlags } = useFeatureFlags();

  const [plan, setPlan] = useState<NutritionPlan | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // #1580: the selected day is a date; the gym's today replaces the device clock once the API answers.
  const [today, setToday] = useState<string>(deviceToday());
  const [selectedDate, setSelectedDate] = useState<string>(deviceToday());
  const [progress, setProgress] = useState<NutritionProgress>(EMPTY_PROGRESS);
  // The summary cards are always today's day, week and month, whichever week the calendar shows.
  const [summary, setSummary] = useState<NutritionProgress>(EMPTY_PROGRESS);
  const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set());
  // #1603: goal / dietary-restriction completions, keyed `goal|id|date` / `restriction|id|date` -> level.
  const [reqLevels, setReqLevels] = useState<Record<string, 'partial' | 'done'>>({});
  const [pendingReq, setPendingReq] = useState<string | null>(null);
  const [pendingMeal, setPendingMeal] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    if (!(isSuperadmin && !isImpersonating) && !isFeatureEnabled(featureFlags, 'member_web.my_nutrition')) { router.replace(`/${locale}`); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{ plan: NutritionPlan | null }>('/me/nutrition-plan');
        if (!cancelled) setPlan(data.plan);
        if (data.plan) {
          const logs = await apiFetch<{ meal_id: number; logged_date: string }[]>('/me/nutrition-logs');
          if (!cancelled) setDoneKeys(new Set(logs.map((l) => `${l.meal_id}|${String(l.logged_date).slice(0, 10)}`)));
          const reqLogs = await apiFetch<{ goal_id: number | null; restriction_id: number | null; level: 'partial' | 'done'; logged_date: string }[]>('/me/nutrition-requirement-logs');
          if (!cancelled) {
            setReqLevels(Object.fromEntries(reqLogs.map((l) => [
              `${l.goal_id != null ? 'goal' : 'restriction'}|${l.goal_id ?? l.restriction_id}|${String(l.logged_date).slice(0, 10)}`, l.level])));
          }
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? t('nutrition.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appLoading, isLinked, locale, isSuperadmin, isImpersonating, featureFlags]);

  async function loadProgress(date: string) {
    try {
      const p = await apiFetch<NutritionProgress>(`/me/nutrition-progress?date=${date}`);
      setProgress(p);
      const anchor = p.today ?? today;
      if (p.today && p.today !== today) {
        if (selectedDate === today) setSelectedDate(p.today);
        setToday(p.today);
      }
      if (date === anchor) setSummary(p);
      else setSummary(await apiFetch<NutritionProgress>(`/me/nutrition-progress?date=${anchor}`));
    } catch { /* progress is decoration; the meals still render */ }
  }

  useEffect(() => {
    if (appLoading || !isLinked || !plan) return;
    loadProgress(selectedDate);
  }, [appLoading, isLinked, plan, selectedDate, doneKeys]);

  function onTouchEnd(e: React.TouchEvent) {
    if (!touchStart) return;
    const t0 = e.changedTouches[0];
    const delta = swipeWeekDelta(t0.clientX - touchStart.x, t0.clientY - touchStart.y);
    setTouchStart(null);
    if (delta !== 0) setSelectedDate((d) => shiftWeekWithin(d, delta, today));
  }

  // The server enforces the future-date rule; the button is only hidden for it.
  async function markMealDone(meal: Meal) {
    setPendingMeal(meal.id);
    setMessage(null);
    try {
      await apiFetch('/me/nutrition-logs', { method: 'POST', body: JSON.stringify({ meal_id: meal.id, logged_date: selectedDate }) });
      setDoneKeys((prev) => new Set(prev).add(`${meal.id}|${selectedDate}`));
    } catch (err: any) { setMessage(err.message ?? t('nutrition.error')); }
    finally { setPendingMeal(null); }
  }

  // #1603: the server decides eligibility and only ever raises partial -> done.
  async function markRequirement(kind: 'goal' | 'restriction', id: number, level: 'partial' | 'done') {
    const key = `${kind}|${id}|${selectedDate}`;
    setPendingReq(key);
    setMessage(null);
    try {
      const body = { [kind === 'goal' ? 'goal_id' : 'restriction_id']: id, logged_date: selectedDate, level };
      const row = await apiFetch<{ level: 'partial' | 'done' }>('/me/nutrition-requirement-logs', { method: 'POST', body: JSON.stringify(body) });
      setReqLevels((prev) => ({ ...prev, [key]: row.level }));
      loadProgress(selectedDate);
    } catch (err: any) { setMessage(err.message ?? t('nutrition.error')); }
    finally { setPendingReq(null); }
  }

  function requirementActions(kind: 'goal' | 'restriction', id: number) {
    const level = reqLevels[`${kind}|${id}|${selectedDate}`];
    if (level === 'done') {
      return <span style={{ ...statusPillStyle(statusTone('completed')), fontSize: 11, padding: '2px 8px', alignSelf: 'flex-start' }}>✓ {t('nutrition.meal_done')}</span>;
    }
    const actions = completionActions(kind, level, selectedDate, today);
    if (!actions.showMarkDone) return null;
    const busy = pendingReq === `${kind}|${id}|${selectedDate}`;
    return (
      <div style={styles.reqActions}>
        {level === 'partial' && <span style={{ ...statusPillStyle(statusTone('scheduled')), fontSize: 11, padding: '2px 8px' }}>{t('nutrition.partially_done_state')}</span>}
        <button type="button" onClick={() => markRequirement(kind, id, 'done')} disabled={busy} style={styles.cardBtn}>{t('nutrition.mark_done')}</button>
        {actions.showPartiallyDone && (
          <button type="button" onClick={() => markRequirement(kind, id, 'partial')} disabled={busy} style={styles.cardBtn}>{t('nutrition.partially_done')}</button>
        )}
      </div>
    );
  }

  function mealTypeLabel(mealType: string | null): string | null {
    if (!mealType) return null;
    try { return t(`nutrition.meal_type.${mealType}` as any); } catch { return mealType; }
  }

  function mealTitleOf(meal: Meal) {
    return mealTitle(meal.display_name, meal.meal_type, mealTypeLabel(meal.meal_type));
  }

  if (loading) {
    return <main style={styles.container}><p style={styles.hint}>{t('nutrition.loading')}</p></main>;
  }

  if (error) {
    return <main style={styles.container}><p style={{ ...styles.hint, color: memberTheme.statusError }}>{error}</p></main>;
  }

  // Defaulted rather than read straight off the payload: the Member app and the
  // API deploy from two workflows, so a member app running briefly ahead of the
  // API must render the page rather than throw on a missing key.
  const goals = plan?.goals ?? [];
  const restrictions = plan?.restrictions ?? [];

  // The plan's day numbering is Monday-based (0=Mon … 6=Sun), unlike training's.
  // #1874: another week shows its own dates and results; the month card stays today's.
  const otherWeek = weekStart(selectedDate) !== weekStart(today);
  const ddmm = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
  const dayLabel = otherWeek ? ddmm(selectedDate) : t('nutrition.progress_day');
  const weekLabel = otherWeek ? t('nutrition.progress_week_of', { date: ddmm(weekStart(selectedDate)) }) : t('nutrition.progress_week');
  const dayCounts = otherWeek ? progress.day : summary.day;
  const weekCounts = otherWeek ? progress.week : summary.week;
  const selectedWeekday = mondayIndex(selectedDate);
  const mealsForDate: Meal[] = (plan?.days ?? [])
    .filter((d) => d.weekday === ALL_DAYS_WEEKDAY || d.weekday === selectedWeekday)
    .flatMap((d) => d.meals);

  return (
    <main style={styles.container} onTouchStart={(e) => setTouchStart({ x: e.touches[0].clientX, y: e.touches[0].clientY })} onTouchEnd={onTouchEnd}>

      {message && <p style={{ ...styles.hint, color: memberTheme.statusError, margin: '0 0 12px' }}>{message}</p>}

      {!plan ? (
        <div style={styles.emptyCard}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🥗</div>
          <p style={styles.hint}>{t('nutrition.empty')}</p>
        </div>
      ) : (
        <>
          <TrainingSummaryCards cards={[
            { label: dayLabel, percent: dayCounts.percent, detail: `${dayCounts.completed}/${dayCounts.total}` },
            { label: weekLabel, percent: weekCounts.percent, detail: `${weekCounts.completed}/${weekCounts.total}` },
            { label: t('nutrition.progress_month'), percent: summary.month.percent, detail: `${summary.month.completed}/${summary.month.total}` },
          ]} />

          <div style={styles.weekCard}>
            <div style={styles.weekNav}>
            <button type="button" onClick={() => setSelectedDate((d) => shiftWeekWithin(d, -1, today))}
                    aria-label={t('nutrition.week_prev')} title={t('nutrition.week_prev')} style={styles.weekArrow}>‹</button>
            <div style={{ ...styles.weekdayBar, flex: 1, minWidth: 0 }} role="group" aria-label={t('nutrition.week_nav_hint')}>
              {weekDates(selectedDate).map((date) => {
                const selected = date === selectedDate;
                const isTodayCell = date === today;
                const status: NutritionDayStatus = progress.week_days.find((d) => d.date === date)?.status ?? 'rest';
                const statusText = t(`nutrition.status_${status}` as any);
                const longDate = dayText(locale, date, { weekday: 'long', day: 'numeric', month: 'long' });
                return (
                  <div key={date} style={styles.dayCell}>
                    <button type="button" onClick={() => setSelectedDate(date)}
                            aria-pressed={selected} aria-current={isTodayCell ? 'date' : undefined}
                            aria-label={longDate} title={isTodayCell ? t('nutrition.today_marker') : undefined}
                            style={{ ...styles.dayBtn, ...(isTodayCell && !selected ? styles.dayBtnToday : {}), ...(selected ? styles.dayBtnActive : {}) }}>
                      <span style={styles.dayName}>{dayText(locale, date, { weekday: 'short' })}</span>
                      <span style={styles.dayNum}>{Number(date.slice(8, 10))}</span>
                    </button>
                    <button type="button" onClick={() => setLegendOpen(true)}
                            aria-label={`${longDate}: ${statusText}. ${t('nutrition.status_legend_open')}`}
                            title={statusText} style={styles.statusBtn}>
                      <span aria-hidden="true" style={{ ...styles.statusDot, background: DAY_STATUS_COLOR[status] }} />
                      <span style={styles.srOnly}>{statusText}</span>
                    </button>
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => setSelectedDate((d) => shiftWeekWithin(d, 1, today))}
                    disabled={!canShowNextWeek(selectedDate, today)}
                    aria-label={t('nutrition.week_next')} title={t('nutrition.week_next')}
                    style={{ ...styles.weekArrow, ...(!canShowNextWeek(selectedDate, today) ? { opacity: 0.35, cursor: 'default' } : {}) }}>›</button>
            </div>
          </div>

          {legendOpen && (
            <TrainingStatusLegend title={t('nutrition.status_legend_title')} closeLabel={t('nutrition.status_legend_close')}
              items={NUTRITION_DAY_STATUSES.map((st) => ({ status: st, label: t(`nutrition.status_legend_${st}` as any) }))}
              onClose={() => setLegendOpen(false)} />
          )}

          {/* #932 §2 — the goal's name is a slug (`weight_loss`), translated
              before it is shown, and its value and frequency read as
              "1 l · daily". Both sections render through the same row, so they
              cannot drift apart (§4), and each says so in words when it is
              empty rather than disappearing (§5). */}
          <section style={styles.section}>
            <h2 style={styles.h2}>{t('nutrition.goals')}</h2>
            <div style={styles.card}>
              {goals.length === 0 ? (
                <p style={styles.sectionEmpty}>{t('nutrition.goals_empty')}</p>
              ) : (
                <div style={nutritionItemGridStyle}>{goals.map((g) => (
                  <NutritionItemRow
                    key={g.id}
                    name={goalLabel(t, g.item_name)}
                    detail={goalDetail(t, g)}
                    imageUrl={g.image_url ?? null}
                    actions={requirementActions('goal', g.id)}
                  />
                ))}</div>
              )}
            </div>
          </section>

          <section style={styles.section}>
            <h2 style={styles.h2}>{t('nutrition.restrictions')}</h2>
            <div style={styles.card}>
              {restrictions.length === 0 ? (
                <p style={styles.sectionEmpty}>{t('nutrition.restrictions_empty')}</p>
              ) : (
                <div style={nutritionItemGridStyle}>{restrictions.map((r) => (
                  <NutritionItemRow key={r.id} name={r.item_name} imageUrl={r.image_url} crossed
                    actions={requirementActions('restriction', r.id)} />
                ))}</div>
              )}
            </div>
          </section>

          {/* #1580: the selected date's meals — a day with its own weekday plus the "every day" ones. */}
          <section style={styles.section}>
            <h2 style={styles.h2}>{dayText(locale, selectedDate, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
            {mealsForDate.length === 0 ? (
              <p style={styles.hint}>{t('nutrition.no_meals_today')}</p>
            ) : (
              <div style={styles.card}>
                {mealsForDate.map((meal) => {
                  const done = doneKeys.has(`${meal.id}|${selectedDate}`);
                  const title = mealTitleOf(meal);
                  return (
                    <div key={meal.id} style={styles.mealRow}>
                      <div style={styles.mealHead}>
                        <p style={styles.mealName}>
                          {title.title}
                          {title.suffix && <span style={styles.mealType}> · {title.suffix}</span>}
                        </p>
                        {done && <span style={{ ...statusPillStyle(statusTone('completed')), fontSize: 11, padding: '2px 8px' }}>✓ {t('nutrition.meal_done')}</span>}
                        {/* #1580: completion belongs to the whole meal, so its action sits in the meal's own header. */}
                        {completionActions('meal', done ? 'done' : undefined, selectedDate, today).showMarkDone && (
                          <button type="button" onClick={() => markMealDone(meal)} disabled={pendingMeal === meal.id}
                                  aria-label={t('nutrition.mark_done_aria', { name: title.title })} style={styles.reqBtn}>
                            {t('nutrition.mark_done')}
                          </button>
                        )}
                      </div>
                      {/* #722: the meal's foods are swipeable image cards, one
                          carousel per meal — the items of a meal are the
                          alternatives the member chooses between. */}
                      <NutritionFoodCarousel items={meal.items} label={title.title} />
                      {meal.notes && <p style={styles.mealNotes}>{meal.notes}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container:  { padding: 16, maxWidth: 720, margin: '0 auto' },
  title:      { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  section:    { marginBottom: 20 },
  h2:         { margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font, textTransform: 'uppercase', letterSpacing: '0.05em' },
  card:       { ...sectionCardStyle, padding: '4px 18px' },
  mealHead:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  reqActions: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' },
  reqBtn:     { ...primaryButtonStyle, padding: '6px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600 },
  cardBtn:    { ...primaryButtonStyle, display: 'block', boxSizing: 'border-box', maxWidth: '100%', width: '100%', margin: 0, padding: '10px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600 },
  markDoneBtn: { ...primaryButtonStyle, display: 'block', width: '100%', margin: '10px 0 0', padding: '10px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600 },
  weekCard:   { ...sectionCardStyle, padding: 10, marginBottom: 20 },
  weekNav:    { display: 'flex', alignItems: 'flex-start', gap: 4 },
  weekArrow:  { background: 'none', border: 'none', color: memberTheme.text, fontSize: 24, lineHeight: 1, padding: '6px 8px', minWidth: 36, minHeight: 36, cursor: 'pointer' },
  weekdayBar: { display: 'flex', justifyContent: 'space-between', gap: 4 },
  dayCell:    { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, position: 'relative' },
  dayBtn:     { width: '100%', maxWidth: 48, borderRadius: 10, padding: '6px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, background: memberTheme.surface, color: memberTheme.textMuted, border: `1px solid ${memberTheme.separator}`, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  dayBtnToday: { borderColor: memberTheme.primaryButton, color: memberTheme.text },
  dayBtnActive: { background: memberTheme.primaryButton, color: memberTheme.primaryButtonText, borderColor: memberTheme.primaryButton },
  dayName:    { fontSize: 11, fontWeight: 600, textTransform: 'capitalize' },
  dayNum:     { fontSize: 16, fontWeight: 700 },
  statusBtn:  { background: 'none', border: 'none', padding: 6, cursor: 'pointer', display: 'flex' },
  statusDot:  { width: 12, height: 12, borderRadius: '50%', display: 'block' },
  srOnly:     { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
  mealRow:    { padding: '12px 0', borderBottom: `1px solid ${memberTheme.separator}` },
  mealName:   { margin: 0, fontSize: 15, fontWeight: 700, color: memberTheme.text },
  mealType:   { fontSize: 12, fontWeight: 500, color: memberTheme.textMuted, textTransform: 'none' },
  mealNotes:  { margin: '4px 0 0', fontSize: 12, color: memberTheme.textMuted, fontStyle: 'italic' },
  sectionEmpty: { color: memberTheme.textMuted, fontSize: 13, margin: '14px 0' },
  emptyCard:  { ...sectionCardStyle, padding: '40px 24px', textAlign: 'center' },
  hint:       { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
