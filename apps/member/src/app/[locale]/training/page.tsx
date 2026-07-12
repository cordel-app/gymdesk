'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

interface WorkoutExercise {
  id: number; position: number;
  exercise_id: number; name: string;
  video_url: string | null; image_url: string | null;
  reps: string | null; rest_seconds: number | null;
}

interface TrainingPlan {
  id: number; name: string; description: string | null;
  weekday: number | null; workout_name: string;
  exercises: WorkoutExercise[] | null;
}

interface WorkoutLog {
  id: number; logged_date: string; series: number;
  weight: string | null; reps: number;
  exercise_id: number; exercise_name: string;
}

const todayWeekday = () => (new Date().getDay() + 6) % 7; // JS Sun=0 → Mon=0

export default function TrainingPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading } = useApp();

  const [plans, setPlans] = useState<TrainingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedWeekday, setSelectedWeekday] = useState<number>(todayWeekday());
  const [expandedExercise, setExpandedExercise] = useState<number | null>(null);
  const [history, setHistory] = useState<WorkoutLog[]>([]);
  const [logForm, setLogForm] = useState({ workout_exercise_id: 0, series: '1', weight: '', reps: '' });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function loadPlans() {
    setLoading(true);
    try {
      setPlans(await apiFetch<TrainingPlan[]>('/me/training-plans'));
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    loadPlans();
  }, [appLoading, isLinked, locale]);

  async function openHistory(we: WorkoutExercise) {
    if (expandedExercise === we.exercise_id) { setExpandedExercise(null); return; }
    setExpandedExercise(we.exercise_id);
    setLogForm({ workout_exercise_id: we.id, series: '1', weight: '', reps: we.reps?.split('x').pop() ?? '' });
    try {
      setHistory(await apiFetch<WorkoutLog[]>(`/me/workout-logs?exercise=${we.exercise_id}`));
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
  }

  async function logSet(planId: number) {
    if (!logForm.workout_exercise_id || !logForm.reps) return;
    setPending(true);
    try {
      await apiFetch('/me/workout-logs', { method: 'POST', body: JSON.stringify({
        training_plan_id: planId,
        workout_exercise_id: logForm.workout_exercise_id,
        series: parseInt(logForm.series, 10),
        weight: logForm.weight ? parseFloat(logForm.weight) : null,
        reps: parseInt(logForm.reps, 10),
      })});
      // Refresh history for the currently-expanded exercise
      if (expandedExercise) {
        setHistory(await apiFetch<WorkoutLog[]>(`/me/workout-logs?exercise=${expandedExercise}`));
      }
      setLogForm({ ...logForm, series: String(parseInt(logForm.series, 10) + 1) });
      setMessage(t('training.logged'));
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
    finally { setPending(false); }
  }

  const plansForWeekday = useMemo(() => {
    const scheduled = plans.filter((p) => p.weekday === selectedWeekday);
    const unscheduled = plans.filter((p) => p.weekday === null);
    return { scheduled, unscheduled };
  }, [plans, selectedWeekday]);

  if (loading) {
    return <main style={styles.container}><p style={styles.hint}>{t('training.loading')}</p></main>;
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('training.title')}</h1>

      {message && <div style={styles.message}>{message}</div>}

      <div style={styles.weekdayBar}>
        {[0, 1, 2, 3, 4, 5, 6].map((d) => (
          <button key={d} onClick={() => setSelectedWeekday(d)}
                  style={{ ...styles.weekdayBtn, ...(d === selectedWeekday ? styles.weekdayBtnActive : {}) }}>
            {t(`training.weekday_short_${d}`)}
          </button>
        ))}
      </div>

      {plans.length === 0 ? (
        <p style={styles.hint}>{t('training.empty')}</p>
      ) : plansForWeekday.scheduled.length === 0 && plansForWeekday.unscheduled.length === 0 ? (
        <p style={styles.hint}>{t('training.no_plan_today')}</p>
      ) : (
        [...plansForWeekday.scheduled, ...plansForWeekday.unscheduled].map((plan) => (
          <section key={plan.id} style={styles.planCard}>
            <h2 style={styles.planName}>{plan.name}</h2>
            {plan.description && <p style={styles.planDesc}>{plan.description}</p>}

            {(plan.exercises ?? []).map((we) => (
              <div key={we.id} style={styles.exerciseCard}>
                <div style={styles.exerciseHead}>
                  <div style={{ flex: 1 }}>
                    <div style={styles.exerciseName}>{we.name}</div>
                    <div style={styles.exerciseMeta}>
                      {we.reps ?? '—'} · {we.rest_seconds ?? '—'}s
                    </div>
                  </div>
                  {we.video_url && (
                    <a href={we.video_url} target="_blank" rel="noopener noreferrer" style={styles.videoLink}>▶</a>
                  )}
                  <button onClick={() => openHistory(we)} style={styles.expandBtn}>
                    {expandedExercise === we.exercise_id ? '−' : '+'}
                  </button>
                </div>

                {expandedExercise === we.exercise_id && (
                  <div style={styles.expandBody}>
                    <div style={styles.logForm}>
                      <label style={styles.miniLabel}>
                        {t('training.series')}
                        <input type="number" min="1" value={logForm.series}
                               onChange={(e) => setLogForm({ ...logForm, series: e.target.value })}
                               style={styles.miniInput} />
                      </label>
                      <label style={styles.miniLabel}>
                        {t('training.weight')}
                        <input type="number" min="0" step="0.5" value={logForm.weight}
                               onChange={(e) => setLogForm({ ...logForm, weight: e.target.value })}
                               style={styles.miniInput} />
                      </label>
                      <label style={styles.miniLabel}>
                        {t('training.reps')}
                        <input type="number" min="1" value={logForm.reps}
                               onChange={(e) => setLogForm({ ...logForm, reps: e.target.value })}
                               style={styles.miniInput} />
                      </label>
                      <button onClick={() => logSet(plan.id)} disabled={pending}
                              style={styles.logBtn}>
                        {pending ? '…' : t('training.log')}
                      </button>
                    </div>

                    {history.length > 0 && (
                      <div style={styles.history}>
                        <h4 style={styles.historyHead}>{t('training.history')}</h4>
                        <ul style={styles.historyList}>
                          {history.slice(0, 20).map((h) => (
                            <li key={h.id} style={styles.historyRow}>
                              <span>{h.logged_date.slice(0, 10)}</span>
                              <span>#{h.series}</span>
                              <span>{h.weight ? `${parseFloat(h.weight)} kg` : '—'} · {h.reps} reps</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </section>
        ))
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, maxWidth: 720, margin: '0 auto' },
  title: { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: '#18181b' },
  message: { background: '#e6f6ec', color: '#1e7e40', padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 14 },
  weekdayBar: { display: 'flex', gap: 4, marginBottom: 16, overflowX: 'auto' },
  weekdayBtn: { flex: 1, padding: '10px 0', background: '#fff', color: '#71717a', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' },
  weekdayBtnActive: { background: '#18181b', color: '#fff' },
  planCard: { background: '#fff', borderRadius: 12, padding: 16, marginBottom: 16 },
  planName: { margin: 0, fontSize: 17, fontWeight: 700 },
  planDesc: { margin: '4px 0 12px', fontSize: 13, color: '#71717a' },
  exerciseCard: { borderTop: '1px solid #eee', paddingTop: 10, marginTop: 10 },
  exerciseHead: { display: 'flex', gap: 8, alignItems: 'center' },
  exerciseName: { fontSize: 15, fontWeight: 600, color: '#18181b' },
  exerciseMeta: { fontSize: 12, color: '#71717a' },
  videoLink: { textDecoration: 'none', color: '#6c63ff', fontSize: 18, padding: '4px 8px' },
  expandBtn: { width: 30, height: 30, borderRadius: '50%', border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: 16 },
  expandBody: { marginTop: 10, padding: 10, background: '#fafafa', borderRadius: 8 },
  logForm: { display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' },
  miniLabel: { fontSize: 11, color: '#71717a', display: 'flex', flexDirection: 'column', gap: 2 },
  miniInput: { width: 70, padding: '6px 8px', borderRadius: 4, border: '1px solid #ccc', fontSize: 14 },
  logBtn: { padding: '8px 14px', background: '#18181b', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  history: { marginTop: 12 },
  historyHead: { margin: '0 0 6px', fontSize: 12, fontWeight: 600, color: '#71717a', textTransform: 'uppercase', letterSpacing: '0.05em' },
  historyList: { listStyle: 'none', padding: 0, margin: 0 },
  historyRow: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', fontSize: 12, color: '#555' },
  hint: { color: '#71717a', fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
