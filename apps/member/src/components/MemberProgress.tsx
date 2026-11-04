'use client';

import { ExerciseInfo } from './ExerciseInfo';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LineChart } from '@gymdesk/charts';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDayMonth } from '@/lib/gymFormat';
import { MemberGoalCard } from '@/components/MemberGoalCard';
import { ExerciseVideoViewer } from '@/components/ExerciseMediaViewer';
import { exerciseVideoKind, exerciseVideoPosterUrl } from '@/lib/exerciseMedia';
import { inputStyle, memberTheme, noticeStyle } from '@/lib/memberChrome';
import {
  type ProgressDetail, type ProgressSummary,
  NO_PROGRESS_FILTERS, daysNewestFirst, filterProgress, formatBestResult, formatMaxWeight, formatSetValue,
  gymToday, muscleLabel, progressChartPoints, progressMuscles, resultUnitKey,
  type ProgressDateRange, type ProgressFilters,
} from '@/lib/memberProgress';

/**
 * #1224 — the **My Progress** tab: one collapsible card per exercise the member
 * has logged. Every figure is the API's (`/me/progress`); this file draws.
 * The summary is on the collapsed card, the chart and the daily readings open
 * with it (fetched when the card opens). #1917: the card is fully opaque (no
 * image behind the text) and the daily readings are collapsed by default.
 */
export function MemberProgress() {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [items, setItems] = useState<ProgressSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filters, setFilters] = useState<ProgressFilters>(NO_PROGRESS_FILTERS);
  const [openId, setOpenId] = useState<Record<number, boolean>>({});
  const [videoItem, setVideoItem] = useState<ProgressSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ProgressSummary[]>('/me/progress/exercises')
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) return <p style={{ ...noticeStyle('error'), marginTop: 16 }}>{t('progress.error')}</p>;
  if (items === null) return <p style={styles.hint}>{t('progress.loading')}</p>;
  if (items.length === 0) return <p style={styles.hint}>{t('progress.empty')}</p>;

  const visible = filterProgress(items, filters, gymToday(new Date(), gym.time_zone));
  const muscles = progressMuscles(items);
  const filtered = filters.exerciseId !== null || filters.muscle !== null || filters.range !== 'all';

  // #2321 — the same Play control as My Training Plan (▶, external pages open in a tab).
  const playButton = (item: ProgressSummary) => {
    const url = item.video_url;
    const kind = exerciseVideoKind(url);
    if (!url || !kind) return undefined;
    const label = t('exercise_media.play_video_of', { name: item.exercise_name });
    return kind === 'external'
      ? <a href={url} target="_blank" rel="noreferrer" aria-label={label} style={styles.playBtn}>▶</a>
      : <button type="button" onClick={() => setVideoItem(item)} aria-label={label} style={styles.playBtn}>▶</button>;
  };

  return (
    <div>
      <div style={styles.filters}>
        <label style={styles.filterField}>
          <span style={styles.statLabel}>{t('progress.filter_exercise')}</span>
          <select
            style={inputStyle}
            value={filters.exerciseId ?? ''}
            onChange={(e) => setFilters({ ...filters, exerciseId: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">{t('progress.filter_all_exercises')}</option>
            {items.map((i) => <option key={i.exercise_id} value={i.exercise_id}>{i.exercise_name}</option>)}
          </select>
        </label>
        {muscles.length > 0 && (
          <label style={styles.filterField}>
            <span style={styles.statLabel}>{t('progress.filter_muscle')}</span>
            <select
              style={inputStyle}
              value={filters.muscle ?? ''}
              onChange={(e) => setFilters({ ...filters, muscle: e.target.value === '' ? null : e.target.value })}
            >
              <option value="">{t('progress.filter_all_muscles')}</option>
              {muscles.map((m) => <option key={m} value={m}>{muscleLabel(m)}</option>)}
            </select>
          </label>
        )}
        <label style={styles.filterField}>
          <span style={styles.statLabel}>{t('progress.filter_date')}</span>
          <select
            style={inputStyle}
            value={filters.range}
            onChange={(e) => setFilters({ ...filters, range: e.target.value as ProgressDateRange })}
          >
            <option value="all">{t('progress.range_all')}</option>
            <option value="week">{t('progress.range_week')}</option>
            <option value="month">{t('progress.range_month')}</option>
          </select>
        </label>
      </div>
      {visible.length === 0 && <p style={styles.hint}>{t('progress.no_matches')}</p>}
      {visible.map((item) => {
        const unitKey = resultUnitKey(item.best_result?.slug);
        const best = formatBestResult(item.best_result, unitKey ? t(unitKey) : null, gym);
        const thumb = item.image_thumbnail_url ?? item.image_url;
        return (
          <div key={item.exercise_id} style={{ marginTop: 16 }}>
            <MemberGoalCard
              title={item.exercise_name}
              summary={t('progress.summary', { days: item.days_exercised })}
              expanded={Boolean(openId[item.exercise_id])}
              onToggle={() => setOpenId((o) => ({ ...o, [item.exercise_id]: !o[item.exercise_id] }))}
              imageUrl={thumb}
              previewUrl={item.image_url ?? thumb}
              imageFallback={thumb ? t('nutrition.no_image') : undefined}
              actions={playButton(item)}
              imageDetails={<ExerciseInfo info={item} />}
            >
              <div style={styles.stats}>
                <Stat label={t('progress.days_exercised')} value={String(item.days_exercised)} />
                <Stat label={t('progress.max_weight')} value={formatMaxWeight(item.max_weight, t('progress.unit_kg'), gym)} />
                <Stat label={t('progress.best_result')} value={best} />
              </div>
              <ExerciseDetail item={item} />
            </MemberGoalCard>
          </div>
        );
      })}
      {videoItem?.video_url && (
        <ExerciseVideoViewer
          url={videoItem.video_url}
          poster={exerciseVideoPosterUrl({ exercise_video_url: videoItem.video_url, exercise_video_thumbnail_url: videoItem.video_thumbnail_url })}
          name={videoItem.exercise_name}
          onClose={() => setVideoItem(null)}
        />
      )}
      {filtered && visible.length === 0 && (
        <button type="button" style={styles.clear} onClick={() => setFilters(NO_PROGRESS_FILTERS)}>{t('progress.clear_filters')}</button>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.stat}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statValue}>{value}</span>
    </div>
  );
}

function ExerciseDetail({ item }: { item: ProgressSummary }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [detail, setDetail] = useState<ProgressDetail | null>(null);
  const [readingsOpen, setReadingsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ProgressDetail>(`/me/progress/exercises/${item.exercise_id}`)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { /* the summary above stays readable */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.exercise_id]);

  const unitKey = resultUnitKey(item.result_kind?.slug);
  const unit = unitKey ? t(unitKey) : null;
  const points = useMemo(() => (detail ? progressChartPoints(detail.days, unit, gym) : []), [detail, unit, gym]);
  if (!detail) return null;

  return (
    <div style={styles.detail}>
      {points.some((p) => p.y !== null) && (
        <LineChart
          points={points}
          height={200}
          ariaLabel={t('progress.chart_aria', { name: item.exercise_name })}
          axisLabelFormatter={(value) => formatGymDayMonth(new Date(value).toISOString().slice(0, 10), gym)}
        />
      )}
      <button type="button" onClick={() => setReadingsOpen((v) => !v)} aria-expanded={readingsOpen} style={styles.readingsToggle}>
        <span style={styles.statLabel}>{t('progress.history')}</span>
        <span aria-hidden="true" style={styles.caret}>{readingsOpen ? '▾' : '▸'}</span>
      </button>
      {readingsOpen && (detail.days.length === 0 ? <span style={styles.hintInline}>{t('progress.history_empty')}</span> : (
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th} />
            <th style={styles.th}>{t('progress.set')}</th>
            <th style={styles.th}>{t('progress.reps')}</th>
            <th style={styles.th}>{t('progress.weight')}</th>
          </tr>
        </thead>
        <tbody>
          {daysNewestFirst(detail.days).flatMap((day) =>
            (day.sets.length ? day.sets : [null]).map((s, i) => (
              <tr key={`${day.logged_date}-${i}`}>
                <td style={styles.td}>{i === 0 ? formatGymDayMonth(day.logged_date, gym) : ''}</td>
                <td style={styles.td}>{s ? s.set_number : '—'}</td>
                <td style={styles.td}>{s ? formatSetValue(s.reps, gym) : '—'}</td>
                <td style={styles.td}>{s ? formatSetValue(s.weight, gym) : '—'}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      ))}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  playBtn: { flex: '0 0 auto', width: 28, height: 28, borderRadius: '50%', padding: 0, border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, lineHeight: 1, textDecoration: 'none', background: memberTheme.primaryButton, color: memberTheme.primaryButtonText },
  filters: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 },
  filterField: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 140px', minWidth: 0 },
  clear: { background: 'none', border: 'none', color: memberTheme.textSecondary, textDecoration: 'underline', cursor: 'pointer', display: 'block', margin: '0 auto', font: 'inherit' },
  readingsToggle: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
    background: 'none', border: 'none', padding: '6px 0', cursor: 'pointer', font: 'inherit', textAlign: 'left',
  },
  caret: { fontSize: 12, color: memberTheme.textMuted },
  hintInline: { color: memberTheme.textMuted, fontSize: 13 },
  hint: { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '20px 0' },
  stats: { display: 'flex', gap: 16, flexWrap: 'wrap', padding: '0 16px 12px' },
  stat: { display: 'flex', flexDirection: 'column', gap: 2 },
  statLabel: {
    fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
    color: memberTheme.textSecondary,
  },
  statValue: { fontSize: 15, fontWeight: 700, color: memberTheme.text },
  detail: { padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, color: memberTheme.text },
  th: { textAlign: 'left', fontSize: 11, fontWeight: 600, color: memberTheme.textMuted, padding: '2px 4px' },
  td: { padding: '4px', borderTop: `1px solid ${memberTheme.separator}` },
};
