'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import { ExerciseMedia } from '@/components/ExerciseMedia';
import { resultUnitKey, resultValueForPayload } from '@/lib/blockResult';
import {
  inputStyle,
  memberTheme,
  noticeStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  sectionCardStyle,
} from '@/lib/memberChrome';

interface BlockExercise {
  id: number; position: number; exercise_id: number; exercise_name: string;
  min_reps: number | null; max_reps: number | null; sets: number | null; rest_seconds: number | null; tempo: string | null;
  // #723: the exercise's own media, already carried by the plan tree (#720) —
  // no request per exercise. #719 turned `exercise_image_thumbnail_url` on, and
  // part 2 `exercise_video_thumbnail_url` — the poster of an uploaded MP4.
  exercise_image_url?: string | null;
  exercise_image_thumbnail_url?: string | null;
  exercise_video_url?: string | null;
  exercise_video_thumbnail_url?: string | null;
}

// #1009: a block carries no `result_type`. Migration 074 (#154) moved the result
// type down to the exercise instance, and `PLAN_TREE_SELECT` stopped sending it
// then — so `block.result_type` was `undefined` here, `undefined !== 'None'`
// passed, and `undefined.toLowerCase()` threw while rendering any block. The
// block's result is one optional free-text value; typed, per-set results are the
// exercise's, logged through `/me/exercise-logs` below.
interface Block {
  id: number; position: number; name: string | null; type: string;
  rounds: number | null; duration_seconds: number | null; work_seconds: number | null; rest_seconds: number | null;
  is_optional: boolean; notes: string | null;
  /** #1232: what the block's global result is counted in; null = the block records none. */
  result_unit?: string | null;
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

interface ExerciseLog {
  id: number; logged_date: string;
  sets: { id: number; set_number: number; weight: number | null; reps: number | null; rpe: number | null }[] | null;
}

/** #1297: how many existing logs the inline table shows under the entry row. */
const INLINE_LOG_LIMIT = 5;

const todayWeekday = () => (new Date().getDay() + 6) % 7; // JS Sun=0 → Mon=0
const todayDate = () => new Date().toISOString().slice(0, 10);

export default function TrainingPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading, isSuperadmin } = useApp();
  const { isImpersonating } = useImpersonation();
  const { flags: featureFlags } = useFeatureFlags();

  const [plans, setPlans] = useState<TrainingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedWeekday, setSelectedWeekday] = useState<number>(todayWeekday());
  const [expandedExercise, setExpandedExercise] = useState<number | null>(null);
  const [logs, setLogs] = useState<Record<number, ExerciseLog[]>>({});
  const [draft, setDraft] = useState<{ weight: string; reps: string }>({ weight: '', reps: '' });
  const [savingLog, setSavingLog] = useState(false);
  const [doneBlocks, setDoneBlocks] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [resultInputs, setResultInputs] = useState<Record<number, string>>({});

  async function loadPlans() {
    setLoading(true);
    try {
      setPlans(await apiFetch<TrainingPlan[]>('/me/training-plans'));
      const blockLogs = await apiFetch<{ workout_block_id: number; logged_date: string }[]>('/me/workout-block-logs');
      const today = todayDate();
      setDoneBlocks(new Set(blockLogs.filter((l) => String(l.logged_date).slice(0, 10) === today).map((l) => l.workout_block_id)));
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    if (!(isSuperadmin && !isImpersonating) && !isFeatureEnabled(featureFlags, 'member_web.my_training_plan')) { router.replace(`/${locale}`); return; }
    loadPlans();
  }, [appLoading, isLinked, locale, isSuperadmin, isImpersonating, featureFlags]);

  async function loadLogs(we: BlockExercise) {
    try {
      const rows = await apiFetch<ExerciseLog[]>(`/me/exercise-logs?exercise=${we.exercise_id}&limit=${INLINE_LOG_LIMIT}`);
      setLogs((prev) => ({ ...prev, [we.id]: rows }));
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
  }

  function openExercise(we: BlockExercise) {
    if (expandedExercise === we.id) { setExpandedExercise(null); return; }
    setExpandedExercise(we.id);
    setDraft({ weight: '', reps: '' });
    loadLogs(we);
  }

  // #1297: no Save button — the entry row is persisted as soon as focus leaves
  // it with the required input (reps) filled in.
  async function commitDraft(we: BlockExercise) {
    if (savingLog || !draft.reps) return;
    setSavingLog(true);
    try {
      await apiFetch('/me/exercise-logs', {
        method: 'POST',
        body: JSON.stringify({
          workout_exercise_id: we.id,
          logged_date: todayDate(),
          sets: [{
            set_number: 1,
            weight: draft.weight ? parseFloat(draft.weight) : null,
            reps: parseInt(draft.reps, 10),
          }],
        }),
      });
      setDraft({ weight: '', reps: '' });
      await loadLogs(we);
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
    finally { setSavingLog(false); }
  }

  async function markBlockDone(block: Block) {
    setPending(true);
    try {
      await apiFetch('/me/workout-block-logs', {
        method: 'POST',
        body: JSON.stringify({
          workout_block_id: block.id,
          logged_date: todayDate(),
          result_value: resultUnitKey(block.result_unit) ? resultValueForPayload(resultInputs[block.id]) : null,
        }),
      });
      setDoneBlocks((prev) => new Set(prev).add(block.id));
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
                      <span style={styles.blockTypeBadge}>
                        {t(`training.block_type_${block.type.toLowerCase()}`)}
                        {block.rounds ? ` · ${t('training.block_rounds', { count: block.rounds })}` : ''}
                      </span>
                      {doneBlocks.has(block.id) && <span style={styles.doneChip}>✓ {t('training.done')}</span>}
                    </div>
                  </div>
                </div>

                {(block.exercises ?? []).map((we) => (
                  <div key={we.id} style={styles.exerciseCard}>
                    <div style={styles.exerciseHead}>
                      <div style={styles.exerciseTitleLine}>
                        <span style={styles.exerciseName}>{we.exercise_name}</span>
                        <span style={styles.exerciseMeta}>
                          — {we.min_reps ?? '—'}{we.max_reps && we.max_reps !== we.min_reps ? `-${we.max_reps}` : ''} reps
                          {we.sets ? ` × ${we.sets} sets` : ''} · {we.rest_seconds ?? '—'}s
                        </span>
                      </div>
                      <ExerciseMedia exercise={we} />
                      <button onClick={() => openExercise(we)} style={styles.expandBtn}>
                        {expandedExercise === we.id ? '−' : '+'}
                      </button>
                    </div>

                    {expandedExercise === we.id && (
                      <div style={styles.expandBody}>
                        <table style={styles.logTable}>
                          <thead>
                            <tr>
                              <th style={styles.logTh}>{t('training.log_date')}</th>
                              <th style={styles.logTh}>{t('training.weight')}</th>
                              <th style={styles.logTh}>{t('training.reps')}</th>
                              <th style={styles.logTh} />
                            </tr>
                          </thead>
                          <tbody>
                            <tr onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commitDraft(we); }}>
                              <td style={styles.logTd}>{t('training.new_entry')}</td>
                              <td style={styles.logTd}>
                                <input type="number" min="0" step="0.5" aria-label={t('training.weight')} value={draft.weight}
                                       onChange={(e) => setDraft({ ...draft, weight: e.target.value })} style={styles.miniInput} />
                              </td>
                              <td style={styles.logTd}>
                                <input type="number" min="0" aria-label={t('training.reps')} value={draft.reps}
                                       onChange={(e) => setDraft({ ...draft, reps: e.target.value })}
                                       onKeyDown={(e) => { if (e.key === 'Enter') commitDraft(we); }} style={styles.miniInput} />
                              </td>
                              <td style={styles.logTd}>
                                <button type="button" aria-label={t('training.add_log')} onClick={() => commitDraft(we)}
                                        disabled={savingLog || !draft.reps} style={styles.addSetBtn}>+</button>
                              </td>
                            </tr>
                            {(logs[we.id] ?? []).map((log) => {
                              const sets = log.sets ?? [];
                              const isToday = String(log.logged_date).slice(0, 10) === todayDate();
                              return (
                                <tr key={log.id}>
                                  <td style={styles.logTd}>
                                    {String(log.logged_date).slice(0, 10)}
                                    {isToday && <span style={styles.newChip}>{t('training.new_chip')}</span>}
                                  </td>
                                  <td style={styles.logTd}>{sets.map((s) => s.weight ?? '—').join(' / ') || '—'}</td>
                                  <td style={styles.logTd}>{sets.map((s) => s.reps ?? '—').join(' / ') || '—'}</td>
                                  <td style={styles.logTd} />
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}

                <div style={styles.blockDoneRow}>
                  {(() => {
                    const unitKey = resultUnitKey(block.result_unit);
                    if (!unitKey) return null;
                    return (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>{t('training.block_result')}:</span>
                        <input
                          type="number"
                          min="0"
                          inputMode="decimal"
                          aria-label={t('training.block_result')}
                          value={resultInputs[block.id] ?? ''}
                          onChange={(e) => setResultInputs({ ...resultInputs, [block.id]: e.target.value })}
                          style={styles.miniInput}
                        />
                        <span>{t(unitKey)}</span>
                      </label>
                    );
                  })()}
                  {!doneBlocks.has(block.id) && (
                    <button onClick={() => markBlockDone(block)} disabled={pending} style={styles.blockDoneBtn}>
                      {t('training.mark_done')}
                    </button>
                  )}
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
  title: { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  message: { ...noticeStyle('success'), marginBottom: 12 },
  weekdayBar: { display: 'flex', gap: 4, marginBottom: 16, overflowX: 'auto' },
  weekdayBtn: { flex: 1, padding: '10px 0', background: memberTheme.surface, color: memberTheme.textMuted, border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' },
  weekdayBtnActive: { background: memberTheme.primaryButton, color: memberTheme.primaryButtonText },
  planCard: { ...sectionCardStyle, padding: 16, marginBottom: 16 },
  planName: { margin: 0, fontSize: 17, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font },
  planDesc: { margin: '4px 0 12px', fontSize: 13, color: memberTheme.textMuted },
  blockCard: { borderTop: `1px solid ${memberTheme.separator}`, paddingTop: 10, marginTop: 10 },
  blockHead: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 },
  blockName: { fontSize: 14, fontWeight: 700, color: memberTheme.text, display: 'flex', alignItems: 'center', gap: 8 },
  blockTypeBadge: {
    fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '2px 8px',
    color: memberTheme.title2,
    background: `color-mix(in srgb, ${memberTheme.title2} 12%, ${memberTheme.surface})`,
  },
  exerciseCard: { marginTop: 8, marginLeft: 8 },
  exerciseHead: { display: 'flex', gap: 8, alignItems: 'center' },
  exerciseTitleLine: { flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 6 },
  exerciseName: { fontSize: 15, fontWeight: 600, color: memberTheme.text },
  doneChip: { fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '2px 8px', color: memberTheme.statusSuccess, background: `color-mix(in srgb, ${memberTheme.statusSuccess} 12%, ${memberTheme.surface})` },
  newChip: { marginLeft: 6, fontSize: 10, fontWeight: 600, borderRadius: 999, padding: '1px 6px', color: memberTheme.title2, background: `color-mix(in srgb, ${memberTheme.title2} 12%, ${memberTheme.surface})` },
  logTable: { width: '100%', borderCollapse: 'collapse', fontSize: 13, color: memberTheme.text },
  logTh: { textAlign: 'left', fontSize: 11, fontWeight: 600, color: memberTheme.textMuted, padding: '2px 4px' },
  logTd: { padding: '4px', borderTop: `1px solid ${memberTheme.separator}` },
  exerciseMeta: { fontSize: 12, color: memberTheme.textMuted },
  expandBtn: { width: 30, height: 30, borderRadius: '50%', border: `1px solid ${memberTheme.inputBorder}`, background: memberTheme.surface, color: memberTheme.text, cursor: 'pointer', fontSize: 16 },
  expandBody: { marginTop: 10, padding: 10, background: memberTheme.pageBackground, borderRadius: 8 },
  miniInput: { ...inputStyle, width: 70, padding: '6px 8px', borderRadius: 4, fontSize: 14 },
  addSetBtn: { ...secondaryButtonStyle, padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600 },
  blockDoneRow: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 },
  blockDoneBtn: { ...primaryButtonStyle, padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600 },
  hint: { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
