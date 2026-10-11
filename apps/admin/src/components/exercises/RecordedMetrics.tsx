'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { recordedMetricSlugs } from '@/lib/exerciseCategories';
import { listNameBadgeStyle } from '@/components/listChrome';
import { exerciseSectionLabelStyle } from './exerciseFieldChrome';
import { EXERCISE_EMPTY_VALUE, resultTypeLabel, type ResultTypeRow } from './exerciseForm';

/**
 * #1360 stage 2: the read-only Recorded Metrics section. The metrics are derived
 * from the exercise's category by the API (`CATEGORY_RESULT_TYPE_SLUGS`); this
 * renders non-interactive chips for the category's set, or — for a missing or
 * unsupported category — whatever the exercise still stores, without guessing.
 */
export function RecordedMetrics({ category, stored }: { category: string | null | undefined; stored: ResultTypeRow[] | null | undefined }) {
  const t = useTranslations('exercises');
  const slugs = recordedMetricSlugs(category);
  const rows: ResultTypeRow[] = slugs
    ? slugs.map((slug, i) => ({ id: -(i + 1), slug, name: slug }))
    : (stored ?? []);
  return (
    <div>
      <p style={exerciseSectionLabelStyle}>{t('label_recorded_metrics')}</p>
      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: '#888' }}>{EXERCISE_EMPTY_VALUE}</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {rows.map((rt) => (
            <span key={rt.slug} style={{ ...listNameBadgeStyle, marginLeft: 0 }}>
              {resultTypeLabel(rt, (key) => t(key as any))}
            </span>
          ))}
        </div>
      )}
      <p style={{ margin: '6px 0 0', fontSize: 12, color: '#888' }}>{t('recorded_metrics_help')}</p>
    </div>
  );
}
