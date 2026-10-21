'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import { MemberProgress } from '@/components/MemberProgress';
import { ExerciseMedia } from '@/components/ExerciseMedia';
import { TrainingSummaryCards } from '@/components/TrainingSummaryCards';
import { TrainingStatusLegend, DAY_STATUS_COLOR } from '@/components/TrainingStatusLegend';
import { BlockExerciseCarousel } from '@/components/BlockExerciseCarousel';
import { StandaloneExercises } from '@/components/StandaloneExercises';
import { ExerciseDetailsDialog } from '@/components/ExerciseDetailsDialog';
import { ExerciseVideoViewer } from '@/components/ExerciseMediaViewer';
import { exerciseVideoKind, exerciseVideoPosterUrl } from '@/lib/exerciseMedia';
import { DAY_STATUSES, dayStatus, dayStatusKey } from '@/lib/trainingDayStatus';
import {
  EMPTY_PROGRESS, TrainingProgress, deviceToday, stepWeek, swipeWeekDelta, weekDates, weekStart, weekdayOf,
} from '@/lib/trainingWeek';
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
  /** #1527: the exercise's full Description, localized by the API. */
  exercise_description?: string | null;
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
  // #1370 stage 2: the selected day is a date; the gym's today replaces the device clock once the API answers.
  const [today, setToday] = useState<string>(deviceToday());
  const [selectedDate, setSelectedDate] = useState<string>(deviceToday());
  const [progress, setProgress] = useState<TrainingProgress>(EMPTY_PROGRESS);
  // #1879: the day and week cards follow the selected date; only the month card stays today's.
  const [summary, setSummary] = useState<TrainingProgress>(EMPTY_PROGRESS);
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const selectedWeekday = weekdayOf(selectedDate);
  const ddmm = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
  const dayLabel = selectedDate === today ? t('training.progress_day') : ddmm(selectedDate);
  const weekLabel = weekStart(selectedDate) === weekStart(today)
    ? t('training.progress_week')
    : t('training.progress_week_of', { date: ddmm(weekStart(selectedDate)) });
  const [expandedExercise, setExpandedExercise] = useState<number | null>(null);
  const [detailsExercise, setDetailsExercise] = useState<BlockExercise | null>(null);
  const [videoExercise, setVideoExercise] = useState<BlockExercise | null>(null);
  const [logs, setLogs] = useState<Record<number, ExerciseLog[]>>({});
  const [draft, setDraft] = useState<{ weight: string; reps: string }>({ weight: '', reps: '' });
  const [savingLog, setSavingLog] = useState(false);
  const [allBlockLogs, setAllBlockLogs] = useState<{ workout_block_id: number; logged_date: string }[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [resultInputs, setResultInputs] = useState<Record<number, string>>({});
  const [legendOpen, setLegendOpen] = useState(false);
  // #1224: the page has two tabs; My Training Plan stays the default.
  const [tab, setTab] = useState<'plan' | 'progress'>('plan');

  async function loadPlans() {
    setLoading(true);
    try {
      setPlans(await apiFetch<TrainingPlan[]>('/me/training-plans'));
      const blockLogs = await apiFetch<{ workout_block_id: number; logged_date: string }[]>('/me/workout-block-logs');
      setAllBlockLogs(blockLogs);
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    if (!(isSuperadmin && !isImpersonating) && !isFeatureEnabled(featureFlags, 'member_web.my_training_plan')) { router.replace(`/${locale}`); return; }
    loadPlans();
  }, [appLoading, isLinked, locale, isSuperadmin, isImpersonating, featureFlags]);

  const doneBlocks = useMemo(
    () => new Set(allBlockLogs.filter((l) => String(l.logged_date).slice(0, 10) === selectedDate).map((l) => l.workout_block_id)),
    [allBlockLogs, selectedDate],
  );

  async function loadProgress(date: string) {
    try {
      const p = await apiFetch<TrainingProgress>(`/me/training-progress?date=${date}`);
      setProgress(p);
      if (p.today && p.today !== today) {
        // First answer: adopt the gym's today, and move the selection with it when it was still on the device's.
        if (selectedDate === today) setSelectedDate(p.today);
        setToday(p.today);
      }
      const anchor = p.today ?? today;
      if (date === anchor) setSummary(p);
      else setSummary(await apiFetch<TrainingProgress>(`/me/training-progress?date=${anchor}`));
    } catch { /* progress is decoration; the workouts still render */ }
  }

  useEffect(() => {
    if (appLoading || !isLinked) return;
    loadProgress(selectedDate);
  }, [appLoading, isLinked, selectedDate, allBlockLogs]);

  function onTouchEnd(e: React.TouchEvent) {
    if (!touchStart) return;
    const t0 = e.changedTouches[0];
    const delta = swipeWeekDelta(t0.clientX - touchStart.x, t0.clientY - touchStart.y);
    setTouchStart(null);
    if (delta !== 0) setSelectedDate((d) => stepWeek(d, delta, today));
  }

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
          logged_date: selectedDate,
          sets: [{
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
          logged_date: selectedDate,
          result_value: resultUnitKey(block.result_unit) ? resultValueForPayload(resultInputs[block.id]) : null,
        }),
      });
      setAllBlockLogs((prev) => [...prev, { workout_block_id: block.id, logged_date: selectedDate }]);
    } catch (err: any) { setMessage(err.message ?? t('common.error')); }
    finally { setPending(false); }
  }

  const allWorkouts = useMemo(() => plans.flatMap((p) => p.workouts ?? []), [plans]);

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
    <main style={styles.container} onTouchStart={(e) => setTouchStart({ x: e.touches[0].clientX, y: e.touches[0].clientY })} onTouchEnd={onTouchEnd}>

      <div role="tablist" style={styles.tabs}>
        {(['plan', 'progress'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            style={{ ...styles.tab, ...(tab === id ? styles.tabActive : null) }}
          >
            {t(id === 'plan' ? 'training.tab_plan' : 'training.tab_progress')}
          </button>
        ))}
      </div>

      {tab === 'progress' ? <MemberProgress /> : (<>
      {message && <div style={styles.message}>{message}</div>}

      <TrainingSummaryCards cards={[
        { label: dayLabel, percent: progress.day.percent, detail: `${progress.day.completed}/${progress.day.total}` },
        { label: weekLabel, percent: progress.week.percent, detail: `${progress.week.completed}/${progress.week.total}` },
        { label: t('training.progress_month'), percent: summary.month.percent, detail: `${summary.month.completed}/${summary.month.total}` },
      ]} />

      <div style={styles.weekCard}>
        <div style={styles.weekNav}>
        <button type="button" onClick={() => setSelectedDate((d) => stepWeek(d, -1, today))}
                aria-label={t('training.week_prev')} title={t('training.week_prev')} style={styles.weekArrow}>‹</button>
        <div style={{ ...styles.weekdayBar, flex: 1, minWidth: 0 }} role="group" aria-label={t('training.week_nav_hint')}>
          {weekDates(selectedDate).map((date) => {
            const selected = date === selectedDate;
            const isTodayCell = date === today;
            const status = dayStatus(date, weekdayOf(date), today, allWorkouts, allBlockLogs);
            const longDate = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
            return (
              <div key={date} style={styles.dayCell}>
                <button type="button" onClick={() => setSelectedDate(date)}
                        aria-pressed={selected} aria-current={isTodayCell ? 'date' : undefined}
                        aria-label={longDate}
                        title={isTodayCell ? t('training.today_marker') : undefined}
                        style={{ ...styles.dayBtn, ...(isTodayCell && !selected ? styles.dayBtnToday : {}), ...(selected ? styles.dayBtnActive : {}) }}>
                  <span style={styles.dayName}>{new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))}</span>
                  <span style={styles.dayNum}>{Number(date.slice(8, 10))}</span>
                </button>
                <button type="button" onClick={() => setLegendOpen(true)}
                        aria-label={`${longDate}: ${t(dayStatusKey(status))}. ${t('training.status_legend_open')}`}
                        title={t(dayStatusKey(status))} style={styles.statusBtn}>
                  <span aria-hidden="true" style={{ ...styles.statusDot, background: DAY_STATUS_COLOR[status] }} />
                  <span style={styles.srOnly}>{t(dayStatusKey(status))}</span>
                </button>
              </div>
            );
          })}
        </div>
        <button type="button" onClick={() => setSelectedDate((d) => stepWeek(d, 1, today))}
                aria-label={t('training.week_next')} title={t('training.week_next')} style={styles.weekArrow}>›</button>
        </div>
      </div>

      {legendOpen && (
        <TrainingStatusLegend title={t('training.status_legend_title')} closeLabel={t('training.status_legend_close')}
          items={DAY_STATUSES.map((st) => ({ status: st, label: t(`training.status_legend_${st}`) }))}
          onClose={() => setLegendOpen(false)} />
      )}

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

                <BlockExerciseCarousel
                  groupLabel={block.name ?? t(`training.block_type_${block.type.toLowerCase()}`)}
                  prevLabel={t('training.exercise_prev')} nextLabel={t('training.exercise_next')}
                  positionLabel={(i, n) => t('training.exercise_position', { current: i, total: n })}
                  cards={(block.exercises ?? []).map((we) => (
                  <div key={we.id} style={{ ...styles.exerciseCard, cursor: 'pointer' }} onClick={() => setDetailsExercise(we)}>
                    <div style={styles.exerciseSquare}
                         role="button" tabIndex={0} aria-label={we.exercise_name}
                         onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setDetailsExercise(we); } }}>
                      <div style={styles.exerciseMedia}><ExerciseMedia exercise={we} fill /></div>
                      <div style={{ ...styles.exerciseInfo, padding: '0 12px' }}>
                        <span style={styles.exerciseNameRow}>
                          <span style={styles.exerciseName}>{we.exercise_name}</span>
                          {we.exercise_video_url && exerciseVideoKind(we.exercise_video_url) === 'external' && (
                            <a href={we.exercise_video_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                               aria-label={t('exercise_media.play_video_of', { name: we.exercise_name })} style={styles.playBtn}>▶</a>
                          )}
                          {we.exercise_video_url && exerciseVideoKind(we.exercise_video_url) !== null && exerciseVideoKind(we.exercise_video_url) !== 'external' && (
                            <button type="button" onClick={(e) => { e.stopPropagation(); setVideoExercise(we); }}
                                    aria-label={t('exercise_media.play_video_of', { name: we.exercise_name })} style={styles.playBtn}>▶</button>
                          )}
                        </span>
                        <span style={styles.exerciseMeta}>
                          {we.min_reps ?? '—'}{we.max_reps && we.max_reps !== we.min_reps ? `-${we.max_reps}` : ''} reps
                          {we.sets ? ` × ${we.sets} sets` : ''} · {we.rest_seconds ?? '—'}s
                        </span>
                      </div>
                    </div>
                    <button type="button" onClick={(e) => { e.stopPropagation(); openExercise(we); }} aria-expanded={expandedExercise === we.id} style={{ ...styles.registerBtn, width: 'calc(100% - 24px)', margin: '8px 12px 12px' }}>
                      {t('training.register')}
                    </button>

                    {expandedExercise === we.id && (
                      <div style={styles.expandBody} onClick={(e) => e.stopPropagation()}>
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
                              const isToday = String(log.logged_date).slice(0, 10) === today;
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
                />

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
      <StandaloneExercises date={selectedDate} />
      {detailsExercise && (
        <ExerciseDetailsDialog exercise={detailsExercise} description={detailsExercise.exercise_description ?? null} onClose={() => setDetailsExercise(null)} />
      )}
      {videoExercise?.exercise_video_url && (
        <ExerciseVideoViewer url={videoExercise.exercise_video_url} poster={exerciseVideoPosterUrl(videoExercise)} name={videoExercise.exercise_name} onClose={() => setVideoExercise(null)} />
      )}
      </>)}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, maxWidth: 720, margin: '0 auto' },
  message: { ...noticeStyle('success'), marginBottom: 12 },
  weekCard: { ...sectionCardStyle, padding: 10, marginBottom: 20 },
  weekNav: { display: 'flex', alignItems: 'flex-start', gap: 4 },
  weekArrow: { background: 'none', border: 'none', color: memberTheme.text, fontSize: 24, lineHeight: 1, padding: '6px 8px', minWidth: 36, minHeight: 36, cursor: 'pointer' },
  weekdayBar: { display: 'flex', justifyContent: 'space-between', gap: 4 },
  dayCell: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, position: 'relative' },
  dayBtn: { width: '100%', maxWidth: 48, borderRadius: 10, padding: '6px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, background: memberTheme.surface, color: memberTheme.textMuted, border: `1px solid ${memberTheme.separator}`, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  dayBtnToday: { borderColor: memberTheme.primaryButton, color: memberTheme.text },
  dayBtnActive: { background: memberTheme.primaryButton, color: memberTheme.primaryButtonText, borderColor: memberTheme.primaryButton },
  dayName: { fontSize: 11, fontWeight: 600, textTransform: 'capitalize' },
  dayNum: { fontSize: 16, fontWeight: 700 },
  statusBtn: { background: 'none', border: 'none', padding: 6, cursor: 'pointer', display: 'flex' },
  statusDot: { width: 12, height: 12, borderRadius: '50%', display: 'block' },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
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
  exerciseCard: { marginTop: 8, padding: 0, overflow: 'hidden', borderRadius: 12, border: `1px solid ${memberTheme.separator}`, background: memberTheme.surface },
  exerciseSquare: { width: '100%', display: 'flex', flexDirection: 'column', gap: 8, boxSizing: 'border-box' },
  exerciseMedia: { display: 'block', width: '100%' },
  exerciseInfo: { display: 'flex', flexDirection: 'column', gap: 2, width: '100%' },
  registerBtn: { ...primaryButtonStyle, display: 'block', boxSizing: 'border-box', maxWidth: '100%', width: '100%', margin: '8px 0 0', padding: '10px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600 },
  exerciseNameRow: { display: 'flex', alignItems: 'center', gap: 8 },
  playBtn: { flex: '0 0 auto', width: 28, height: 28, borderRadius: '50%', padding: 0, border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, lineHeight: 1, textDecoration: 'none', background: memberTheme.primaryButton, color: memberTheme.primaryButtonText },
  exerciseName: { fontSize: 15, fontWeight: 600, color: memberTheme.text },
  doneChip: { fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '2px 8px', color: memberTheme.statusSuccess, background: `color-mix(in srgb, ${memberTheme.statusSuccess} 12%, ${memberTheme.surface})` },
  newChip: { marginLeft: 6, fontSize: 10, fontWeight: 600, borderRadius: 999, padding: '1px 6px', color: memberTheme.title2, background: `color-mix(in srgb, ${memberTheme.title2} 12%, ${memberTheme.surface})` },
  logTable: { width: '100%', borderCollapse: 'collapse', fontSize: 13, color: memberTheme.text },
  logTh: { textAlign: 'left', fontSize: 11, fontWeight: 600, color: memberTheme.textMuted, padding: '2px 4px' },
  logTd: { padding: '4px', borderTop: `1px solid ${memberTheme.separator}` },
  exerciseMeta: { fontSize: 12, color: memberTheme.textMuted },
  expandBody: { margin: '10px 12px 12px', padding: 10, background: memberTheme.pageBackground, borderRadius: 8 },
  miniInput: { ...inputStyle, width: 56, minWidth: 0, boxSizing: 'border-box', padding: '6px 8px', borderRadius: 4, fontSize: 14 },
  addSetBtn: { ...secondaryButtonStyle, padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600 },
  blockDoneRow: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 },
  blockDoneBtn: { ...primaryButtonStyle, padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600 },
  hint: { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '20px 0' },
  tabs: { display: 'flex', gap: 8, margin: '12px 0', overflowX: 'auto' },
  tab: { ...secondaryButtonStyle, padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', opacity: 0.7 },
  tabActive: { ...primaryButtonStyle, opacity: 1 },
};
