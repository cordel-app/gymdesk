'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import { NutritionFoodCarousel } from '@/components/NutritionFoodCarousel';
import { NutritionItemRow } from '@/components/NutritionItemRow';
import { memberTheme, sectionCardStyle } from '@/lib/memberChrome';
import {
  NutritionFoodItem,
  NutritionGoalItem,
  NutritionRestrictionItem,
  goalDetail,
  goalLabel,
} from '@/lib/nutritionFood';

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

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    if (!(isSuperadmin && !isImpersonating) && !isFeatureEnabled(featureFlags, 'member_web.my_nutrition')) { router.replace(`/${locale}`); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{ plan: NutritionPlan | null }>('/me/nutrition-plan');
        if (!cancelled) setPlan(data.plan);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? t('nutrition.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appLoading, isLinked, locale, isSuperadmin, isImpersonating, featureFlags]);

  function weekdayLabel(weekday: number): string {
    if (weekday === ALL_DAYS_WEEKDAY) return t('nutrition.all_days');
    return t(`training.weekday_short_${weekday}` as any);
  }

  function mealTypeLabel(mealType: string | null): string | null {
    if (!mealType) return null;
    try { return t(`nutrition.meal_type.${mealType}` as any); } catch { return mealType; }
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

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('nutrition.title')}</h1>

      {!plan ? (
        <div style={styles.emptyCard}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🥗</div>
          <p style={styles.hint}>{t('nutrition.empty')}</p>
        </div>
      ) : (
        <>
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
                goals.map((g) => (
                  <NutritionItemRow
                    key={g.id}
                    name={goalLabel(t, g.item_name)}
                    detail={goalDetail(t, g)}
                    imageUrl={g.image_url ?? null}
                  />
                ))
              )}
            </div>
          </section>

          <section style={styles.section}>
            <h2 style={styles.h2}>{t('nutrition.restrictions')}</h2>
            <div style={styles.card}>
              {restrictions.length === 0 ? (
                <p style={styles.sectionEmpty}>{t('nutrition.restrictions_empty')}</p>
              ) : (
                restrictions.map((r) => (
                  <NutritionItemRow key={r.id} name={r.item_name} imageUrl={r.image_url} />
                ))
              )}
            </div>
          </section>

          {plan.days.map((day) => (
            <section key={day.id} style={styles.section}>
              <h2 style={styles.h2}>{weekdayLabel(day.weekday)}</h2>
              {day.meals.length === 0 ? (
                <p style={styles.hint}>{t('nutrition.empty')}</p>
              ) : (
                <div style={styles.card}>
                  {day.meals.map((meal) => (
                    <div key={meal.id} style={styles.mealRow}>
                      <p style={styles.mealName}>
                        {meal.display_name}
                        {mealTypeLabel(meal.meal_type) && (
                          <span style={styles.mealType}> · {mealTypeLabel(meal.meal_type)}</span>
                        )}
                      </p>
                      {/* #722: the meal's foods are swipeable image cards, one
                          carousel per meal — the items of a meal are the
                          alternatives the member chooses between. */}
                      <NutritionFoodCarousel items={meal.items} label={meal.display_name} />
                      {meal.notes && <p style={styles.mealNotes}>{meal.notes}</p>}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container:  { padding: 16, maxWidth: 720, margin: '0 auto' },
  title:      { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: memberTheme.title1 },
  section:    { marginBottom: 20 },
  h2:         { margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: memberTheme.title2, textTransform: 'uppercase', letterSpacing: '0.05em' },
  card:       { ...sectionCardStyle, padding: '4px 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  mealRow:    { padding: '12px 0', borderBottom: `1px solid ${memberTheme.separator}` },
  mealName:   { margin: 0, fontSize: 15, fontWeight: 700, color: memberTheme.text },
  mealType:   { fontSize: 12, fontWeight: 500, color: memberTheme.textMuted, textTransform: 'none' },
  mealNotes:  { margin: '4px 0 0', fontSize: 12, color: memberTheme.textMuted, fontStyle: 'italic' },
  sectionEmpty: { color: memberTheme.textMuted, fontSize: 13, margin: '14px 0' },
  emptyCard:  { ...sectionCardStyle, padding: '40px 24px', textAlign: 'center' },
  hint:       { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
