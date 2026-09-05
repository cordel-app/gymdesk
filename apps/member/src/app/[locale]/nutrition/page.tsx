'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

interface MealItem { id: number; item_name: string; component_type: string; quantity: number | null; unit: string | null }
interface Meal { id: number; meal_type: string | null; display_name: string; notes: string | null; items: MealItem[] }
interface NutritionDay { id: number; weekday: number; meals: Meal[] }
interface NutritionGoal { id: number; item_name: string; quantity: number; unit: string; frequency: string }
interface NutritionPlan { id: number; name: string; description: string | null; days: NutritionDay[]; goals: NutritionGoal[] }

const ALL_DAYS_WEEKDAY = 7;

export default function NutritionPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading } = useApp();

  const [plan, setPlan] = useState<NutritionPlan | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
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
  }, [appLoading, isLinked, locale]);

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
    return <main style={styles.container}><p style={{ ...styles.hint, color: '#c0392b' }}>{error}</p></main>;
  }

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
          {plan.goals.length > 0 && (
            <section style={styles.section}>
              <h2 style={styles.h2}>{t('nutrition.goals')}</h2>
              <div style={styles.card}>
                {plan.goals.map((g) => (
                  <div key={g.id} style={styles.goalRow}>
                    <span style={styles.goalName}>{g.item_name}</span>
                    <span style={styles.goalValue}>{g.quantity}{g.unit}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

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
                      <p style={styles.mealItems}>
                        {meal.items.map((i) => i.quantity ? `${i.item_name} (${i.quantity}${i.unit ?? ''})` : i.item_name).join(' + ')}
                      </p>
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
  title:      { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: '#18181b' },
  section:    { marginBottom: 20 },
  h2:         { margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.05em' },
  card:       { background: '#fff', borderRadius: 12, padding: '4px 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  mealRow:    { padding: '12px 0', borderBottom: '1px solid #f0f0f0' },
  mealName:   { margin: 0, fontSize: 15, fontWeight: 700, color: '#18181b' },
  mealType:   { fontSize: 12, fontWeight: 500, color: '#71717a', textTransform: 'none' },
  mealItems:  { margin: '4px 0 0', fontSize: 13, color: '#71717a' },
  mealNotes:  { margin: '4px 0 0', fontSize: 12, color: '#a1a1aa', fontStyle: 'italic' },
  goalRow:    { display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f0f0f0' },
  goalName:   { fontSize: 14, fontWeight: 500, color: '#18181b' },
  goalValue:  { fontSize: 14, fontWeight: 700, color: '#18181b' },
  emptyCard:  { background: '#fff', borderRadius: 12, padding: '40px 24px', textAlign: 'center' },
  hint:       { color: '#71717a', fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
