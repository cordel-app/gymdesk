'use client';

import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LineChart } from '@gymdesk/charts';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDayMonth } from '@/lib/gymFormat';
import { MemberCollapsibleCard } from '@/components/MemberCollapsibleCard';
import { memberTheme, noticeStyle } from '@/lib/memberChrome';
import {
  type ProgressDetail, type ProgressSummary,
  cardBackgroundStyle, daysNewestFirst, formatBestResult, formatMaxWeight, formatSetValue,
  progressChartPoints, resultUnitKey,
} from '@/lib/memberProgress';

/**
 * #1224 — the **My Progress** tab: one collapsible card per exercise the member
 * has logged. Every figure is the API's (`/me/progress`); this file draws.
 * The summary is on the collapsed card, the chart and the daily readings open
 * with it (fetched when the card opens), and the exercise's image sits behind
 * the header under a scrim made of the card's own surface colour.
 */
export function MemberProgress() {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [items, setItems] = useState<ProgressSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

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

  return (
    <div>
      {items.map((item) => {
        const unitKey = resultUnitKey(item.best_result?.slug);
        const best = formatBestResult(item.best_result, unitKey ? t(unitKey) : null, gym);
        return (
          <MemberCollapsibleCard
            key={item.exercise_id}
            title={item.exercise_name}
            summary={t('progress.summary', { days: item.days_exercised })}
            cardStyle={cardBackgroundStyle(item.image_url, memberTheme.surface)}
          >
            <div style={styles.stats}>
              <Stat label={t('progress.days_exercised')} value={String(item.days_exercised)} />
              <Stat label={t('progress.max_weight')} value={formatMaxWeight(item.max_weight, t('progress.unit_kg'), gym)} />
              <Stat label={t('progress.best_result')} value={best} />
            </div>
            <ExerciseDetail item={item} />
          </MemberCollapsibleCard>
        );
      })}
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
      <span style={styles.statLabel}>{t('progress.history')}</span>
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
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
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
