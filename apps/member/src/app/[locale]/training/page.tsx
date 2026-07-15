'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

interface BlockExercise {
  id: number; position: number; exercise_id: number; exercise_name: string;
  min_reps: number | null; max_reps: number | null; sets: number | null; rest_seconds: number | null; tempo: string | null;
}

interface Block {
  id: number; position: number; name: string | null; type: string; result_type: string;
  rounds: number | null; duration_seconds: number | null; work_seconds: number | null; rest_seconds: number | null;
  is_optional: boolean; notes: string | null;
  exercises: BlockExercise[] | null;
}

interface Workout {
  id: number; position: number; name: string; description: string | null; scheduled_weekday: number | null;
  blocks: Block[] | null;
}

interface TrainingPlan {
  id: number; name: string; description: string | null;
  workouts: Workout[] | null;
}

type SetRow = { set_number: number; weight: string; reps: string; rpe: string };

const todayWeekday = () => (new Date().getDay() + 6) % 7; // JS Sun=0 → Mon=0
const todayDate = () => new Date().toISOString().slice(0, 10);

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
  const [setRows, setSetRows] = useState<SetRow[]>([{ set_number: 1, weight: '', reps: '', rpe: '' }]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [resultInputs, setResultInputs] = useState<Record<number, string>>({});

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

  function openExercise(we: BlockExercise) {
    if (expandedExercise === we.id) { setExpandedExercise(null); return; }
    setExpandedExercise(we.id);
    setSetRows([{ set_number: 1, weight: '', reps: '', rpe: '' }]);
  }

  function addSetRow() {
    setSetRows((rows) => [...rows, { set_number: rows.length + 1, weight: '', reps: '', rpe: '' }]);
  }

  async function saveExerciseLog(we: BlockExercise) {
    setPending(true);
    try {
      await apiFetch('/me/exercise-logs', {
        method: 'POST',
        body: JSON.stringify({
          workout_exercise_id: we.id,
          logged_date: todayDate(),
          sets: setRows
            .filter((r) => r.reps || r.weight)
            .map((r) => ({
              set_number: r.set_number,
              weight: r.weight ? parseFloat(r.weight) : null,
              reps: r.reps ? parseInt(r.reps, 10) : null,
              rpe: r.rpe ? parseFloat(r.rpe) : null,
            })),
        }),
      });
      setMessage(t('training.logged'));
      setExpandedExercise(null);
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
    finally { setPending(false); }
  }

  async function markBlockDone(block: Block) {
    setPending(true);
    try {
      await apiFetch('/me/workout-block-logs', {
        method: 'POST',
        body: JSON.stringify({
          workout_block_id: block.id,
          logged_date: todayDate(),
          result_value: block.result_type !== 'None' ? (resultInputs[block.id] ?? null) : null,
        }),
      });
      setMessage(t('training.block_logged'));
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
    finally { setPending(false); }
  }

  // Flatten (plan, workout) pairs across all active plans, grouped by weekday like the old page.
  const workoutsForWeekday = useMemo(() => {
    const entries: { plan: TrainingPlan; workout: Workout }[] = [];
    for (const plan of plans) {
      for (const workout of plan.workouts ?? []) entries.push({ plan, workout });
    }
    const scheduled = entries.filter((e) => e.workout.scheduled_weekday === selectedWeekday);
    const unscheduled = entries.filter((e) => e.workout.scheduled_weekday === null);
    return [...scheduled, ...unscheduled];
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
      ) : workoutsForWeekday.length === 0 ? (
        <p style={styles.hint}>{t('training.no_plan_today')}</p>
      ) : (
        workoutsForWeekday.map(({ plan, workout }) => (
          <section key={workout.id} style={styles.planCard}>
            <h2 style={styles.planName}>{workout.name}</h2>
            <p style={styles.planDesc}>{plan.name}{workout.description ? ` · ${workout.description}` : ''}</p>

            {(workout.blocks ?? []).map((block) => (
              <div key={block.id} style={styles.blockCard}>
                <div style={styles.blockHead}>
                  <div style={{ flex: 1 }}>
                    <div style={styles.blockName}>
                      {block.name ?? t(`training.block_type_${block.type.toLowerCase()}`)}
                      <span style={styles.blockTypeBadge}>{t(`training.block_type_${block.type.toLowerCase()}`)}</span>
                    </div>
                    {block.result_type !== 'None' && (
                      <div style={styles.exerciseMeta}>{t(`training.result_type_${block.result_type.toLowerCase()}`)}</div>
                    )}
                  </div>
                </div>

                {(block.exercises ?? []).map((we) => (
                  <div key={we.id} style={styles.exerciseCard}>
                    <div style={styles.exerciseHead}>
                      <div style={{ flex: 1 }}>
                        <div style={styles.exerciseName}>{we.exercise_name}</div>
                        <div style={styles.exerciseMeta}>
                          {we.min_reps ?? '—'}{we.max_reps && we.max_reps !== we.min_reps ? `-${we.max_reps}` : ''} reps
                          {we.sets ? ` × ${we.sets} sets` : ''} · {we.rest_seconds ?? '—'}s
                        </div>
                      </div>
                      <button onClick={() => openExercise(we)} style={styles.expandBtn}>
                        {expandedExercise === we.id ? '−' : '+'}
                      </button>
                    </div>

                    {expandedExercise === we.id && (
                      <div style={styles.expandBody}>
                        {setRows.map((row, i) => (
                          <div key={i} style={styles.logForm}>
                            <span style={styles.setLabel}>#{row.set_number}</span>
                            <label style={styles.miniLabel}>
                              {t('training.weight')}
                              <input type="number" min="0" step="0.5" value={row.weight}
                                     onChange={(e) => setSetRows(setRows.map((r, j) => j === i ? { ...r, weight: e.target.value } : r))}
                                     style={styles.miniInput} />
                            </label>
                            <label style={styles.miniLabel}>
                              {t('training.reps')}
                              <input type="number" min="0" value={row.reps}
                                     onChange={(e) => setSetRows(setRows.map((r, j) => j === i ? { ...r, reps: e.target.value } : r))}
                                     style={styles.miniInput} />
                            </label>
                            <label style={styles.miniLabel}>
                              {t('training.rpe')}
                              <input type="number" min="1" max="10" step="0.5" value={row.rpe}
                                     onChange={(e) => setSetRows(setRows.map((r, j) => j === i ? { ...r, rpe: e.target.value } : r))}
                                     style={styles.miniInput} />
                            </label>
                          </div>
                        ))}
                        <div style={styles.logActions}>
                          <button onClick={addSetRow} style={styles.addSetBtn}>{t('training.add_set')}</button>
                          <button onClick={() => saveExerciseLog(we)} disabled={pending} style={styles.logBtn}>
                            {pending ? '…' : t('training.save_log')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                <div style={styles.blockDoneRow}>
                  {block.result_type !== 'None' && (
                    <input
                      placeholder={t(`training.result_type_${block.result_type.toLowerCase()}`)}
                      value={resultInputs[block.id] ?? ''}
                      onChange={(e) => setResultInputs({ ...resultInputs, [block.id]: e.target.value })}
                      style={styles.miniInput}
                    />
                  )}
                  <button onClick={() => markBlockDone(block)} disabled={pending} style={styles.blockDoneBtn}>
                    {t('training.mark_done')}
                  </button>
                </div>
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
  blockCard: { borderTop: '1px solid #eee', paddingTop: 10, marginTop: 10 },
  blockHead: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 },
  blockName: { fontSize: 14, fontWeight: 700, color: '#18181b', display: 'flex', alignItems: 'center', gap: 8 },
  blockTypeBadge: { fontSize: 11, fontWeight: 600, color: '#6c63ff', background: '#eeecff', borderRadius: 999, padding: '2px 8px' },
  exerciseCard: { marginTop: 8, marginLeft: 8 },
  exerciseHead: { display: 'flex', gap: 8, alignItems: 'center' },
  exerciseName: { fontSize: 15, fontWeight: 600, color: '#18181b' },
  exerciseMeta: { fontSize: 12, color: '#71717a' },
  expandBtn: { width: 30, height: 30, borderRadius: '50%', border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: 16 },
  expandBody: { marginTop: 10, padding: 10, background: '#fafafa', borderRadius: 8 },
  logForm: { display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 6 },
  setLabel: { fontSize: 12, color: '#71717a', width: 24 },
  miniLabel: { fontSize: 11, color: '#71717a', display: 'flex', flexDirection: 'column', gap: 2 },
  miniInput: { width: 70, padding: '6px 8px', borderRadius: 4, border: '1px solid #ccc', fontSize: 14 },
  logActions: { display: 'flex', gap: 8, marginTop: 4 },
  addSetBtn: { padding: '8px 14px', background: '#fff', color: '#18181b', border: '1px solid #ccc', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  logBtn: { padding: '8px 14px', background: '#18181b', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  blockDoneRow: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 },
  blockDoneBtn: { padding: '8px 14px', background: '#1e7e40', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  hint: { color: '#71717a', fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
